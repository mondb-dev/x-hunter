/**
 * runner/lib/db_backend.js — Database backend switcher
 *
 * Checks DATABASE_URL env var:
 *   - If set → use Postgres (.pg.js modules)
 *   - If not  → use SQLite  (original .js modules)
 *
 * Usage in consumer code:
 *   const { usePostgres } = require('./lib/db_backend');
 *   const db = usePostgres()
 *     ? require('./intelligence/db.pg')
 *     : require('./intelligence/db');
 *
 * Or use the convenience loaders:
 *   const { loadIntelligenceDb, loadScraperDb, loadSprintDb, loadVerificationDb } = require('./lib/db_backend');
 */

'use strict';

const path = require('path');

// Ensure DATABASE_URL is loaded even when callers (verify_one.js, verify_claims.js,
// rescore_all.js, investigate_claim.js, etc.) are spawned from a context that
// doesn't load dotenv itself. Without this, those scripts silently fall back to
// the stale local SQLite DB and overwrite verification_export.json with the
// wrong row count.
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch {}

function usePostgres() {
  return !!process.env.DATABASE_URL;
}

function loadIntelligenceDb() {
  return usePostgres()
    ? require('../intelligence/db.pg')
    : require('../intelligence/db');
}

function loadScraperDb() {
  return usePostgres()
    ? require('../../scraper/db.pg')
    : require('../../scraper/db');
}

function loadSprintDb() {
  return usePostgres()
    ? require('../sprint/db.pg')
    : require('../sprint/db');
}

function loadVerificationDb() {
  return usePostgres()
    ? require('../intelligence/verification_db.pg')
    : require('../intelligence/verification_db');
}

module.exports = { usePostgres, loadIntelligenceDb, loadScraperDb, loadSprintDb, loadVerificationDb };
