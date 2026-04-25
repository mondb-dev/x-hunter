'use strict';
/**
 * runner/intelligence/interactions_db.pg.js — Postgres store for engagement interactions
 *
 * Records every reply (scraper/reply.js) and proactive-reply (runner/proactive_reply.js)
 * exchange so interactions are queryable and recallable — both by Sebastian (via the
 * query_engagement agent tool) and by the META builder (via context load).
 *
 * Schema: infra/migrations/003_interactions.sql
 *
 * All writes are fire-and-forget (non-blocking). If the DB is unavailable the JSON
 * flat file continues to work as the authoritative source.
 */

const { query } = require('../lib/pg');

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS interactions (
  id             BIGSERIAL PRIMARY KEY,
  tweet_id       TEXT,
  interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type           TEXT NOT NULL DEFAULT 'reply',
  from_username  TEXT NOT NULL,
  from_display   TEXT,
  their_text     TEXT,
  our_reply      TEXT NOT NULL,
  memory_used    JSONB NOT NULL DEFAULT '[]',
  cycle          INT,
  tsv            TSVECTOR
    GENERATED ALWAYS AS (
      to_tsvector('english',
        coalesce(their_text,'') || ' ' || coalesce(our_reply,'') || ' ' || coalesce(from_username,'')
      )
    ) STORED
);
CREATE INDEX IF NOT EXISTS interactions_at_idx   ON interactions (interaction_at DESC);
CREATE INDEX IF NOT EXISTS interactions_user_idx  ON interactions (from_username);
CREATE INDEX IF NOT EXISTS interactions_tsv_idx   ON interactions USING GIN (tsv);
CREATE INDEX IF NOT EXISTS interactions_type_idx  ON interactions (type);
`;

let _ensured = false;
async function ensureTable() {
  if (_ensured) return;
  await query(ENSURE_TABLE);
  _ensured = true;
}

/**
 * Insert a single interaction. Non-blocking — logs and swallows errors.
 *
 * @param {object} row
 *   tweet_id      {string}   X tweet ID (optional)
 *   type          {string}   'reply' | 'proactive'
 *   from_username {string}   @handle of the person Sebastian replied to
 *   from_display  {string}   display name (optional)
 *   their_text    {string}   original tweet text
 *   our_reply     {string}   text Sebastian sent
 *   memory_used   {string[]} e.g. ["journal:Day 3...", "article:..."]
 *   interaction_at {string}  ISO timestamp (optional — defaults to NOW())
 *   cycle         {number}   orchestrator cycle number (optional)
 */
async function insertInteraction(row) {
  try {
    await ensureTable();
    const {
      tweet_id      = null,
      type          = 'reply',
      from_username,
      from_display  = null,
      their_text    = null,
      our_reply,
      memory_used   = [],
      interaction_at = null,
      cycle         = null,
    } = row;

    if (!from_username || !our_reply) return; // minimal required fields

    await query(
      `INSERT INTO interactions
         (tweet_id, interaction_at, type, from_username, from_display, their_text, our_reply, memory_used, cycle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [
        tweet_id,
        interaction_at ? new Date(interaction_at) : new Date(),
        type,
        from_username,
        from_display,
        their_text,
        our_reply,
        JSON.stringify(memory_used),
        cycle,
      ]
    );
  } catch (err) {
    // Non-fatal — flat file is primary
    console.warn('[interactions_db] insert failed (non-fatal):', err.message);
  }
}

/**
 * Full-text search across their_text, our_reply, and from_username.
 * Returns up to `limit` rows ordered by relevance then recency.
 *
 * @param {string} queryStr - natural language search terms
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function searchInteractions(queryStr, limit = 20) {
  await ensureTable();
  const tsQuery = queryStr.trim().split(/\s+/).join(' & ');
  const { rows } = await query(
    `SELECT
       tweet_id,
       interaction_at,
       type,
       from_username,
       their_text,
       our_reply,
       memory_used,
       ts_rank(tsv, to_tsquery('english', $1)) AS rank
     FROM interactions
     WHERE tsv @@ to_tsquery('english', $1)
     ORDER BY rank DESC, interaction_at DESC
     LIMIT $2`,
    [tsQuery, limit]
  );
  return rows;
}

/**
 * Get recent interactions with a specific user.
 *
 * @param {string} username - handle (without @)
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function getByUser(username, limit = 10) {
  await ensureTable();
  const handle = username.replace(/^@/, '');
  const { rows } = await query(
    `SELECT tweet_id, interaction_at, type, their_text, our_reply, memory_used
     FROM interactions
     WHERE from_username = $1
     ORDER BY interaction_at DESC
     LIMIT $2`,
    [handle, limit]
  );
  return rows;
}

/**
 * Get N most recent interactions, optionally filtered by type.
 *
 * @param {number} limit
 * @param {string|null} type - 'reply' | 'proactive' | null for all
 * @returns {Promise<object[]>}
 */
async function recentInteractions(limit = 20, type = null) {
  await ensureTable();
  if (type) {
    const { rows } = await query(
      `SELECT tweet_id, interaction_at, type, from_username, their_text, our_reply, memory_used
       FROM interactions
       WHERE type = $1
       ORDER BY interaction_at DESC
       LIMIT $2`,
      [type, limit]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT tweet_id, interaction_at, type, from_username, their_text, our_reply, memory_used
     FROM interactions
     ORDER BY interaction_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { insertInteraction, searchInteractions, getByUser, recentInteractions };
