/**
 * runner/intelligence/db.pg.js — Postgres version of intelligence DB
 *
 * Drop-in async replacement for db.js (better-sqlite3).
 * Same exported functions, but all return Promises.
 *
 * Schema lives in infra/migrations/001_init.sql — no CREATE TABLE here.
 */

'use strict';

const { query, transaction } = require('../lib/pg');

// ── Exported query helpers (used by verification_db.pg.js, etc.) ────────────

/** Run a raw query — thin wrapper for modules that need ad-hoc SQL. */
async function exec(text, params = []) {
  return query(text, params);
}

module.exports = { query, exec, transaction };
