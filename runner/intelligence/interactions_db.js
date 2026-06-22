'use strict';
/**
 * runner/intelligence/interactions_db.js — SQLite store for engagement interactions
 *
 * SQLite sibling of interactions_db.pg.js — exposes the identical async interface
 * (insertInteraction / searchInteractions / getByUser / recentInteractions) so it
 * is a drop-in replacement selected by runner/lib/db_backend.js when DATABASE_URL
 * is unset. Stores into state/intelligence.db (alongside the verification tables).
 *
 * Full-text search uses FTS5 (mirrors the Postgres tsvector path). All writes are
 * fire-and-forget; callers keep a JSON flat file as the authoritative fallback.
 */

const path = require('path');
const Database = require('../node_modules/better-sqlite3');
const config = require('../lib/config');

const DB_PATH = path.join(config.STATE_DIR, 'intelligence.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

let _ensured = false;
function ensureTable() {
  if (_ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS interactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id       TEXT,
      interaction_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      type           TEXT NOT NULL DEFAULT 'reply',
      from_username  TEXT NOT NULL,
      from_display   TEXT,
      their_text     TEXT,
      our_reply      TEXT NOT NULL,
      memory_used    TEXT NOT NULL DEFAULT '[]',
      cycle          INTEGER
    );
    CREATE INDEX IF NOT EXISTS interactions_at_idx   ON interactions (interaction_at DESC);
    CREATE INDEX IF NOT EXISTS interactions_user_idx ON interactions (from_username);
    CREATE INDEX IF NOT EXISTS interactions_type_idx ON interactions (type);

    CREATE VIRTUAL TABLE IF NOT EXISTS interactions_fts USING fts5(
      their_text, our_reply, from_username,
      content='interactions', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS interactions_ai AFTER INSERT ON interactions BEGIN
      INSERT INTO interactions_fts(rowid, their_text, our_reply, from_username)
      VALUES (new.id, new.their_text, new.our_reply, new.from_username);
    END;
    CREATE TRIGGER IF NOT EXISTS interactions_ad AFTER DELETE ON interactions BEGIN
      INSERT INTO interactions_fts(interactions_fts, rowid, their_text, our_reply, from_username)
      VALUES ('delete', old.id, old.their_text, old.our_reply, old.from_username);
    END;
    CREATE TRIGGER IF NOT EXISTS interactions_au AFTER UPDATE ON interactions BEGIN
      INSERT INTO interactions_fts(interactions_fts, rowid, their_text, our_reply, from_username)
      VALUES ('delete', old.id, old.their_text, old.our_reply, old.from_username);
      INSERT INTO interactions_fts(rowid, their_text, our_reply, from_username)
      VALUES (new.id, new.their_text, new.our_reply, new.from_username);
    END;
  `);
  _ensured = true;
}

// Parse memory_used JSON back to an array, matching the pg (JSONB) return shape.
function mapRow(r) {
  if (!r) return r;
  let mem = [];
  try { mem = JSON.parse(r.memory_used || '[]'); } catch { mem = []; }
  return { ...r, memory_used: mem };
}

// Build a safe FTS5 MATCH query: quote each term so punctuation can't break syntax.
function ftsQuery(queryStr) {
  return String(queryStr || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '')}"`)
    .join(' ');
}

async function insertInteraction(row) {
  try {
    ensureTable();
    const {
      tweet_id       = null,
      type           = 'reply',
      from_username,
      from_display   = null,
      their_text     = null,
      our_reply,
      memory_used    = [],
      interaction_at = null,
      cycle          = null,
    } = row;

    if (!from_username || !our_reply) return; // minimal required fields

    db.prepare(
      `INSERT INTO interactions
         (tweet_id, interaction_at, type, from_username, from_display, their_text, our_reply, memory_used, cycle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tweet_id,
      interaction_at || new Date().toISOString(),
      type,
      from_username,
      from_display,
      their_text,
      our_reply,
      JSON.stringify(memory_used || []),
      cycle
    );
  } catch (err) {
    // Non-fatal — flat file is primary
    console.warn('[interactions_db] insert failed (non-fatal):', err.message);
  }
}

async function searchInteractions(queryStr, limit = 20) {
  ensureTable();
  const match = ftsQuery(queryStr);
  if (!match) return [];
  const rows = db.prepare(
    `SELECT i.tweet_id, i.interaction_at, i.type, i.from_username,
            i.their_text, i.our_reply, i.memory_used,
            bm25(interactions_fts) AS rank
       FROM interactions_fts
       JOIN interactions i ON i.id = interactions_fts.rowid
      WHERE interactions_fts MATCH ?
      ORDER BY rank ASC, i.interaction_at DESC
      LIMIT ?`
  ).all(match, limit);
  return rows.map(mapRow);
}

async function getByUser(username, limit = 10) {
  ensureTable();
  const handle = String(username || '').replace(/^@/, '');
  const rows = db.prepare(
    `SELECT tweet_id, interaction_at, type, their_text, our_reply, memory_used
       FROM interactions
      WHERE from_username = ?
      ORDER BY interaction_at DESC
      LIMIT ?`
  ).all(handle, limit);
  return rows.map(mapRow);
}

async function recentInteractions(limit = 20, type = null) {
  ensureTable();
  const rows = type
    ? db.prepare(
        `SELECT tweet_id, interaction_at, type, from_username, their_text, our_reply, memory_used
           FROM interactions WHERE type = ? ORDER BY interaction_at DESC LIMIT ?`
      ).all(type, limit)
    : db.prepare(
        `SELECT tweet_id, interaction_at, type, from_username, their_text, our_reply, memory_used
           FROM interactions ORDER BY interaction_at DESC LIMIT ?`
      ).all(limit);
  return rows.map(mapRow);
}

module.exports = { insertInteraction, searchInteractions, getByUser, recentInteractions };
