/**
 * runner/lib/pg.js — Postgres connection pool singleton
 *
 * Reads DATABASE_URL from env or Secret Manager.
 * All db modules import this pool instead of better-sqlite3.
 */

'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL env var is required (postgresql://user:pass@host:5432/db)');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Cloud SQL requires SSL in production; skip for local dev
  ...(process.env.PG_SSL === 'false' ? {} : {
    ssl: { rejectUnauthorized: false },
  }),
});

pool.on('error', (err) => {
  console.error('[pg] unexpected pool error:', err.message);
});

/**
 * Run a single query. Returns { rows, rowCount }.
 * @param {string} text - SQL with $1, $2, ... placeholders
 * @param {any[]} params - parameter values
 */
async function query(text, params = []) {
  return pool.query(text, params);
}

/**
 * Get a client from the pool for transactions.
 * MUST call client.release() when done.
 */
async function getClient() {
  return pool.connect();
}

/**
 * Run a function inside a transaction.
 * Automatically commits on success, rolls back on error.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Graceful shutdown — drain the pool.
 */
async function close() {
  await pool.end();
}

module.exports = { pool, query, getClient, transaction, close };
