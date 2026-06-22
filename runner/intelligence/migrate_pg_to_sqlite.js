'use strict';
/**
 * runner/intelligence/migrate_pg_to_sqlite.js
 *
 * One-off PG→SQLite reconcile migrator for the SQLite-consolidation (Option A).
 * The SQLite intelligence.db / sprints.db already hold STALE pre-cutover rows;
 * Postgres has been the live store. This merges PG into SQLite without losing data.
 *
 * Self-introspecting: discovers PG + SQLite columns at runtime and migrates the
 * column intersection (JSON-encoding objects/arrays, ISO-encoding dates, 0/1 bools).
 *
 * DRY-RUN BY DEFAULT — reports the plan and counts, writes nothing.
 *   node runner/intelligence/migrate_pg_to_sqlite.js                  # dry-run
 *   node runner/intelligence/migrate_pg_to_sqlite.js --commit          # write to real state/ dbs
 *   node runner/intelligence/migrate_pg_to_sqlite.js --commit --state /tmp/copy   # write to copies
 *
 * Strategies:
 *   upsert — INSERT OR REPLACE keyed by the SQLite table PK (stable cross-DB key;
 *            PG wins on conflict, SQLite-only rows preserved). Used where PK is stable.
 *   append — insert only PG rows whose content-key isn't already present; never
 *            deletes. Used for autoincrement / append-only tables (id is not stable).
 */

const path = require('path');
const Database = require('../node_modules/better-sqlite3');
const { Client } = require('pg');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch {}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const STATE = (() => {
  const i = argv.indexOf('--state');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(__dirname, '..', '..', 'state');
})();

// Merge plan. `key` = content-key columns for append dedup (null => all shared cols except id).
const PLAN = [
  { pg: 'claim_verifications', file: 'intelligence.db', table: 'claim_verifications', strategy: 'upsert', key: null },
  { pg: 'sources',             file: 'intelligence.db', table: 'sources',             strategy: 'upsert', key: null },
  { pg: 'claim_audit_log',     file: 'intelligence.db', table: 'claim_audit_log',     strategy: 'append', key: ['claim_id', 'created_at', 'new_status'] },
  { pg: 'interactions',        file: 'intelligence.db', table: 'interactions',        strategy: 'append', key: ['from_username', 'our_reply', 'interaction_at'],
    // Full schema (mirrors interactions_db.js) so the table exists at migrate time AND
    // inserts populate the FTS index via triggers.
    ensure: `
      CREATE TABLE IF NOT EXISTS interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tweet_id TEXT,
        interaction_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        type TEXT NOT NULL DEFAULT 'reply', from_username TEXT NOT NULL, from_display TEXT,
        their_text TEXT, our_reply TEXT NOT NULL, memory_used TEXT NOT NULL DEFAULT '[]', cycle INTEGER);
      CREATE INDEX IF NOT EXISTS interactions_at_idx   ON interactions (interaction_at DESC);
      CREATE INDEX IF NOT EXISTS interactions_user_idx ON interactions (from_username);
      CREATE INDEX IF NOT EXISTS interactions_type_idx ON interactions (type);
      CREATE VIRTUAL TABLE IF NOT EXISTS interactions_fts USING fts5(
        their_text, our_reply, from_username, content='interactions', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS interactions_ai AFTER INSERT ON interactions BEGIN
        INSERT INTO interactions_fts(rowid, their_text, our_reply, from_username)
        VALUES (new.id, new.their_text, new.our_reply, new.from_username); END;
    ` },
  // sprint tables are relational (FK: tasks/accomplishments -> sprints -> plans). PG is the
  // authoritative + more-complete set, so replace wholesale preserving PG ids (FK-consistent).
  // Drops a few stale SQLite-only pre-cutover rows — acceptable for operational logs.
  { pg: 'plans',               file: 'sprints.db',      table: 'plans',               strategy: 'replace', key: null },
  { pg: 'sprints',             file: 'sprints.db',      table: 'sprints',             strategy: 'replace', key: null },
  { pg: 'tasks',               file: 'sprints.db',      table: 'tasks',               strategy: 'replace', key: null },
  { pg: 'accomplishments',     file: 'sprints.db',      table: 'accomplishments',     strategy: 'replace', key: null },
  { pg: 'daily_logs',          file: 'sprints.db',      table: 'daily_logs',          strategy: 'replace', key: null },
];

function coerce(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function sqliteCols(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name); }
  catch { return []; }
}
function sqlitePk(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().filter(r => r.pk).map(r => r.name); }
  catch { return []; }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — nothing to migrate from.'); process.exit(1); }
  console.log(`\n=== PG→SQLite migrator  [${COMMIT ? 'COMMIT' : 'DRY-RUN'}]  state=${STATE} ===\n`);

  const pg = new Client({ connectionString: url, ssl: false });
  await pg.connect();
  const dbs = {};
  const openDb = (f) => {
    if (!dbs[f]) {
      const d = new Database(path.join(STATE, f));
      d.pragma('foreign_keys = OFF'); // bulk migration; source data is internally consistent
      dbs[f] = d;
    }
    return dbs[f];
  };

  const summary = [];
  for (const m of PLAN) {
    const db = openDb(m.file);
    let scols = sqliteCols(db, m.table);
    if (!scols.length && m.ensure) { db.exec(m.ensure); scols = sqliteCols(db, m.table); }
    if (!scols.length) { summary.push(`${m.pg} → ${m.file}/${m.table}: SQLite table MISSING — skipped`); continue; }

    let pgRows;
    try { pgRows = (await pg.query(`SELECT * FROM "${m.pg}"`)).rows; }
    catch (e) { summary.push(`${m.pg}: PG read error (${e.message}) — skipped`); continue; }

    const pgcols = pgRows.length ? Object.keys(pgRows[0]) : [];
    const shared = scols.filter(c => pgcols.includes(c));
    if (!shared.length) { summary.push(`${m.pg}: no shared columns — skipped`); continue; }

    const keyCols = m.key ? m.key.filter(k => shared.includes(k)) : shared.filter(c => c !== 'id');
    const existing = db.prepare(`SELECT COUNT(*) n FROM ${m.table}`).get().n;

    let toInsert = 0, toReplace = 0, skipped = 0;
    // append: fresh autoincrement ids (never carry PG id — collides). upsert/replace keep all cols.
    const cols = m.strategy === 'append' ? shared.filter(c => c !== 'id') : shared;
    const placeholders = cols.map(() => '?').join(',');
    // upsert: PK-keyed, PG-wins. append: OR IGNORE skips unique/PK collisions (union, never errors).
    // replace: wipe + reinsert PG verbatim incl. ids → FK-consistent for relational sprint tables.
    const verb = m.strategy === 'upsert' ? 'INSERT OR REPLACE' : m.strategy === 'append' ? 'INSERT OR IGNORE' : 'INSERT';
    const stmt = db.prepare(`${verb} INTO ${m.table} (${cols.join(',')}) VALUES (${placeholders})`);
    const existsStmt = (m.strategy === 'append' && keyCols.length)
      ? db.prepare(`SELECT 1 FROM ${m.table} WHERE ${keyCols.map(k => `${k} IS ?`).join(' AND ')} LIMIT 1`)
      : null;

    const run = db.transaction(() => {
      if (m.strategy === 'replace') db.prepare(`DELETE FROM ${m.table}`).run();
      for (const row of pgRows) {
        const vals = cols.map(c => coerce(row[c]));
        if (m.strategy === 'append' && existsStmt) {
          if (existsStmt.get(...keyCols.map(k => coerce(row[k])))) { skipped++; continue; }
          toInsert++;
        } else if (m.strategy === 'upsert') {
          const pk = sqlitePk(db, m.table);
          const present = pk.length && pk.every(k => shared.includes(k))
            ? db.prepare(`SELECT 1 FROM ${m.table} WHERE ${pk.map(k => `${k} IS ?`).join(' AND ')} LIMIT 1`).get(...pk.map(k => coerce(row[k])))
            : false;
          if (present) toReplace++; else toInsert++;
        } else { toInsert++; } // replace
        if (COMMIT) stmt.run(...vals);
      }
      if (!COMMIT) throw new Error('__rollback_dry_run__'); // abort tx so nothing persists
    });
    try { run(); } catch (e) { if (e.message !== '__rollback_dry_run__') throw e; }

    summary.push(
      `${m.pg} → ${m.file}/${m.table}  [${m.strategy}]  pg=${pgRows.length} sqlite_before=${existing}  ` +
      `would_insert=${toInsert} would_replace=${toReplace} skipped_dupe=${skipped}  (cols: ${shared.length}/${pgcols.length})`
    );
  }

  await pg.end();
  console.log(summary.join('\n'));
  console.log(`\n${COMMIT ? 'COMMITTED.' : 'DRY-RUN ONLY — no writes. Re-run with --commit to apply.'}\n`);
}

main().catch(e => { console.error('MIGRATOR FAILED:', e); process.exit(1); });
