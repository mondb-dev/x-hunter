'use strict';

/**
 * runner/intelligence/db.js
 *
 * Opens state/intelligence.db and creates tables if they don't exist.
 * Exports a single `db` singleton (better-sqlite3).
 */

const path = require('path');
const Database = require('../node_modules/better-sqlite3');
const config = require('../lib/config');

const DB_PATH = path.join(config.STATE_DIR, 'intelligence.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    handle            TEXT PRIMARY KEY,
    credibility_tier  INTEGER,
    tier_label        TEXT,
    tier_confidence   TEXT,
    tier_notes        TEXT,
    political_lean    TEXT,
    domain            TEXT,
    ng_no_false_content    INTEGER,
    ng_responsible_info    INTEGER,
    ng_corrects_errors     INTEGER,
    ng_news_vs_opinion     INTEGER,
    ng_no_deceptive_framing INTEGER,
    ng_score          REAL,
    ng_assessed_by    TEXT,
    ng_assessed_at    TEXT,
    ng_criteria_notes TEXT,
    behavior_entry_count   INTEGER,
    behavior_citation_rate REAL,
    behavior_stance_diversity REAL,
    behavior_novelty_avg   REAL,
    behavior_axis_spread   INTEGER,
    behavior_computed_at   TEXT,
    first_seen        TEXT,
    last_seen         TEXT,
    created_at        TEXT,
    updated_at        TEXT
  );

  CREATE TABLE IF NOT EXISTS claims (
    id                    TEXT PRIMARY KEY,
    topic                 TEXT,
    category              TEXT,
    claim_text            TEXT,
    stance                TEXT,
    axis_id               TEXT,
    source_handle         TEXT,
    source_url            TEXT,
    source_tier           INTEGER,
    source_tier_label     TEXT,
    source_ng_score       REAL,
    source_lean           TEXT,
    has_supporting_url    INTEGER DEFAULT 0,
    corroborating_count   INTEGER DEFAULT 0,
    contradicting_count   INTEGER DEFAULT 0,
    status                TEXT DEFAULT 'unverified',
    status_updated_at     TEXT,
    status_notes          TEXT,
    observed_at           TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT
  );

  CREATE TABLE IF NOT EXISTS claim_groups (
    group_id        TEXT PRIMARY KEY,
    topic           TEXT,
    category        TEXT,
    canonical_text  TEXT,
    min_tier        INTEGER,
    claim_ids       TEXT,
    created_at      TEXT,
    updated_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS source_registry_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    handle       TEXT,
    field_changed TEXT,
    old_value    TEXT,
    new_value    TEXT,
    changed_by   TEXT,
    changed_at   TEXT
  );
`);

module.exports = db;
