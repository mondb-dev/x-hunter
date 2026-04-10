#!/usr/bin/env node
/**
 * infra/migrate_sqlite_to_pg.js — One-shot SQLite → Postgres data migration
 *
 * Reads all rows from the 3 SQLite databases and inserts them into Postgres.
 * Idempotent: uses ON CONFLICT DO NOTHING for primary keys.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node infra/migrate_sqlite_to_pg.js
 *
 * Prerequisites:
 *   1. Run infra/migrations/001_init.sql against the Postgres DB first
 *   2. Ensure better-sqlite3 and pg are installed
 */

'use strict';

const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL env var required');
  process.exit(1);
}

const STATE_DIR = path.resolve(__dirname, '../state');
const Database = require('better-sqlite3');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function openSqlite(name) {
  const dbPath = path.join(STATE_DIR, name);
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err) {
    console.warn(`  skipping ${name}: ${err.message}`);
    return null;
  }
}

async function migrateTable(sqliteDb, tableName, pgInsertFn) {
  if (!sqliteDb) return 0;
  let rows;
  try {
    rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all();
  } catch (err) {
    console.warn(`  table ${tableName} not found: ${err.message}`);
    return 0;
  }
  let inserted = 0;
  for (const row of rows) {
    try {
      await pgInsertFn(row);
      inserted++;
    } catch (err) {
      // ON CONFLICT DO NOTHING — skip dupes silently
      if (!err.message.includes('duplicate key')) {
        console.warn(`  error inserting into ${tableName}:`, err.message);
      }
    }
  }
  return inserted;
}

// ── Column helpers — build parameterized INSERT from row keys ───────────────

function buildInsert(table, row, conflictCol) {
  const keys = Object.keys(row);
  const cols = keys.join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const conflict = conflictCol ? `ON CONFLICT(${conflictCol}) DO NOTHING` : '';
  const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ${conflict}`;
  const values = keys.map(k => row[k]);
  return { sql, values };
}

async function insertRow(table, row, conflictCol) {
  const { sql, values } = buildInsert(table, row, conflictCol);
  await pool.query(sql, values);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== SQLite → Postgres Migration ===\n');

  // ── intelligence.db ──────────────────────────────────────────────────────
  console.log('Opening intelligence.db...');
  const intDb = openSqlite('intelligence.db');

  if (intDb) {
    const tables = [
      { name: 'sources', conflict: 'handle' },
      { name: 'claims', conflict: 'id' },
      { name: 'claim_groups', conflict: 'group_id' },
      { name: 'source_registry_log', conflict: null },
      { name: 'claim_verifications', conflict: 'claim_id' },
      { name: 'claim_audit_log', conflict: null },
    ];

    for (const t of tables) {
      const count = await migrateTable(intDb, t.name, (row) => insertRow(t.name, row, t.conflict));
      console.log(`  ${t.name}: ${count} rows`);
    }
    intDb.close();
  }

  // ── index.db ─────────────────────────────────────────────────────────────
  console.log('\nOpening index.db...');
  const idxDb = openSqlite('index.db');

  if (idxDb) {
    // posts — skip tsv column (Postgres trigger auto-generates it)
    let count = await migrateTable(idxDb, 'posts', (row) => insertRow('posts', row, 'id'));
    console.log(`  posts: ${count} rows`);

    count = await migrateTable(idxDb, 'keywords', (row) => insertRow('keywords', row, 'keyword, post_id'));
    console.log(`  keywords: ${count} rows`);

    count = await migrateTable(idxDb, 'accounts', (row) => insertRow('accounts', row, 'username'));
    console.log(`  accounts: ${count} rows`);

    count = await migrateTable(idxDb, 'memory', (row) => {
      // Skip auto-increment id — let Postgres SERIAL handle it
      const { id, ...rest } = row;
      return insertRow('memory', rest, 'file_path');
    });
    console.log(`  memory: ${count} rows`);

    count = await migrateTable(idxDb, 'embeddings', (row) => insertRow('embeddings', row, 'entity_type, entity_id'));
    console.log(`  embeddings: ${count} rows`);

    idxDb.close();
  }

  // ── sprints.db ───────────────────────────────────────────────────────────
  console.log('\nOpening sprints.db...');
  const sprintDb = openSqlite('sprints.db');

  if (sprintDb) {
    // Plans first (sprints reference them)
    let count = await migrateTable(sprintDb, 'plans', (row) => {
      const { id, ...rest } = row;
      return insertRow('plans', rest, 'plan_id');
    });
    console.log(`  plans: ${count} rows`);

    // Sprints — need to map old IDs to new SERIAL IDs
    // Insert with explicit ID to preserve foreign key references
    count = await migrateTable(sprintDb, 'sprints', async (row) => {
      // Use OVERRIDING SYSTEM VALUE to set the serial ID explicitly
      const keys = Object.keys(row);
      const cols = keys.join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO sprints (${cols}) OVERRIDING SYSTEM VALUE VALUES (${placeholders}) ON CONFLICT(plan_id, week) DO NOTHING`,
        keys.map(k => row[k])
      );
    });
    console.log(`  sprints: ${count} rows`);

    count = await migrateTable(sprintDb, 'tasks', async (row) => {
      const keys = Object.keys(row);
      const cols = keys.join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO tasks (${cols}) OVERRIDING SYSTEM VALUE VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        keys.map(k => row[k])
      );
    });
    console.log(`  tasks: ${count} rows`);

    count = await migrateTable(sprintDb, 'accomplishments', (row) => {
      const { id, ...rest } = row;
      return insertRow('accomplishments', rest, null);
    });
    console.log(`  accomplishments: ${count} rows`);

    count = await migrateTable(sprintDb, 'daily_logs', (row) => {
      const { id, ...rest } = row;
      return insertRow('daily_logs', rest, 'plan_id, date');
    });
    console.log(`  daily_logs: ${count} rows`);

    // Reset sequences to max ID + 1
    await pool.query("SELECT setval('sprints_id_seq', COALESCE((SELECT MAX(id) FROM sprints), 0) + 1, false)");
    await pool.query("SELECT setval('tasks_id_seq', COALESCE((SELECT MAX(id) FROM tasks), 0) + 1, false)");
    await pool.query("SELECT setval('plans_id_seq', COALESCE((SELECT MAX(id) FROM plans), 0) + 1, false)");

    sprintDb.close();
  }

  // Reset other sequences
  await pool.query("SELECT setval('memory_id_seq', COALESCE((SELECT MAX(id) FROM memory), 0) + 1, false)");
  await pool.query("SELECT setval('source_registry_log_id_seq', COALESCE((SELECT MAX(id) FROM source_registry_log), 0) + 1, false)");
  await pool.query("SELECT setval('claim_audit_log_id_seq', COALESCE((SELECT MAX(id) FROM claim_audit_log), 0) + 1, false)");
  await pool.query("SELECT setval('accomplishments_id_seq', COALESCE((SELECT MAX(id) FROM accomplishments), 0) + 1, false)");
  await pool.query("SELECT setval('daily_logs_id_seq', COALESCE((SELECT MAX(id) FROM daily_logs), 0) + 1, false)");

  console.log('\n=== Migration complete ===');
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
