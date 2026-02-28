"use strict";
/**
 * scraper/db.js — SQLite index for scraped posts
 *
 * Schema:
 *   posts       — every post with metadata + RAKE keywords
 *   posts_fts   — FTS5 virtual table over (username, text, keywords)
 *   keywords    — inverted index: keyword → post_ids with scores
 *   accounts    — per-account aggregate stats (for follow analysis)
 *
 * The FTS5 table enables full-text queries like:
 *   db.search("automation AI") → ranked post rows
 *
 * The keywords table enables aggregate queries like:
 *   db.topKeywords(24) → [{keyword, count, avg_score}]
 *
 * The accounts table enables follow analysis:
 *   db.followCandidates(minPosts, minScore) → sorted by follow_score
 */

const Database = require("better-sqlite3");
const path     = require("path");
const fs       = require("fs");

const DB_PATH  = path.resolve(__dirname, "../state/index.db");
const PRUNE_DAYS = 7;  // keep 7 days of posts, drop older

// Open / create database
const _db = new Database(DB_PATH);

// WAL mode for faster writes (safe for single-writer)
_db.pragma("journal_mode = WAL");
_db.pragma("synchronous = NORMAL");

// ── Schema ────────────────────────────────────────────────────────────────────
_db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id           TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    ts_iso       TEXT    NOT NULL,
    username     TEXT    NOT NULL,
    display_name TEXT,
    text         TEXT    NOT NULL,
    likes        INTEGER DEFAULT 0,
    rts          INTEGER DEFAULT 0,
    replies      INTEGER DEFAULT 0,
    velocity     REAL    DEFAULT 0,
    trust        INTEGER DEFAULT 0,
    score        REAL    DEFAULT 0,
    keywords     TEXT    DEFAULT '',
    parent_id    TEXT    DEFAULT NULL,
    scraped_at   INTEGER NOT NULL,
    PRIMARY KEY (id)
  );

  CREATE INDEX IF NOT EXISTS idx_posts_ts       ON posts(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_username ON posts(username);
  CREATE INDEX IF NOT EXISTS idx_posts_score    ON posts(score DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_parent   ON posts(parent_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    id       UNINDEXED,
    username,
    text,
    keywords,
    content  = 'posts',
    tokenize = 'unicode61 remove_diacritics 1'
  );

  CREATE TABLE IF NOT EXISTS keywords (
    keyword  TEXT    NOT NULL,
    post_id  TEXT    NOT NULL,
    score    REAL    DEFAULT 0,
    ts       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (keyword, post_id)
  );

  CREATE INDEX IF NOT EXISTS idx_kw_keyword ON keywords(keyword);
  CREATE INDEX IF NOT EXISTS idx_kw_ts      ON keywords(ts DESC);

  CREATE TABLE IF NOT EXISTS accounts (
    username      TEXT    NOT NULL PRIMARY KEY,
    post_count    INTEGER DEFAULT 0,
    avg_score     REAL    DEFAULT 0,
    avg_velocity  REAL    DEFAULT 0,
    top_keywords  TEXT    DEFAULT '',
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    follow_score  REAL    DEFAULT 0,
    followed      INTEGER DEFAULT 0,
    followed_at   INTEGER DEFAULT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_follow_score ON accounts(follow_score DESC);
  CREATE INDEX IF NOT EXISTS idx_accounts_last_seen    ON accounts(last_seen DESC);

  CREATE TABLE IF NOT EXISTS memory (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT    NOT NULL,
    date         TEXT    NOT NULL,
    hour         INTEGER DEFAULT NULL,
    title        TEXT    NOT NULL,
    text_content TEXT    NOT NULL,
    keywords     TEXT    DEFAULT '',
    tx_id        TEXT    DEFAULT NULL,
    file_path    TEXT    NOT NULL UNIQUE,
    indexed_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
  CREATE INDEX IF NOT EXISTS idx_memory_date ON memory(date DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id           UNINDEXED,
    type,
    title,
    text_content,
    keywords,
    content  = 'memory',
    tokenize = 'unicode61 remove_diacritics 1'
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    entity_type  TEXT    NOT NULL,
    entity_id    TEXT    NOT NULL,
    vector       TEXT    NOT NULL,
    embedded_at  INTEGER NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  );

  CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(entity_type);
`);

// ── FTS5 sync triggers ────────────────────────────────────────────────────────
// Keep posts_fts in sync with posts table automatically
_db.exec(`
  CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(id, username, text, keywords)
    VALUES (new.id, new.username, new.text, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, id, username, text, keywords)
    VALUES ('delete', old.id, old.username, old.text, old.keywords);
    INSERT INTO posts_fts(id, username, text, keywords)
    VALUES (new.id, new.username, new.text, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, id, username, text, keywords)
    VALUES ('delete', old.id, old.username, old.text, old.keywords);
  END;
`);

// Memory FTS5 sync triggers
_db.exec(`
  CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(id, type, title, text_content, keywords)
    VALUES (new.id, new.type, new.title, new.text_content, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, id, type, title, text_content, keywords)
    VALUES ('delete', old.id, old.type, old.title, old.text_content, old.keywords);
    INSERT INTO memory_fts(id, type, title, text_content, keywords)
    VALUES (new.id, new.type, new.title, new.text_content, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, id, type, title, text_content, keywords)
    VALUES ('delete', old.id, old.type, old.title, old.text_content, old.keywords);
  END;
`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtInsertPost = _db.prepare(`
  INSERT OR REPLACE INTO posts
    (id, ts, ts_iso, username, display_name, text, likes, rts, replies,
     velocity, trust, score, keywords, parent_id, scraped_at)
  VALUES
    (@id, @ts, @ts_iso, @username, @display_name, @text, @likes, @rts, @replies,
     @velocity, @trust, @score, @keywords, @parent_id, @scraped_at)
`);

const stmtInsertKeyword = _db.prepare(`
  INSERT OR REPLACE INTO keywords (keyword, post_id, score, ts)
  VALUES (@keyword, @post_id, @score, unixepoch() * 1000)
`);

const stmtSearch = _db.prepare(`
  SELECT p.*, bm25(posts_fts) AS rank
  FROM posts_fts
  JOIN posts p ON p.id = posts_fts.id
  WHERE posts_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`);

const stmtTopKeywords = _db.prepare(`
  SELECT keyword,
         COUNT(*)    AS count,
         AVG(score)  AS avg_score,
         MAX(ts)     AS last_seen
  FROM   keywords
  WHERE  ts > ?
  GROUP  BY keyword
  ORDER  BY count DESC, avg_score DESC
  LIMIT  ?
`);

const stmtRecentPosts = _db.prepare(`
  SELECT * FROM posts
  WHERE  ts > ? AND parent_id IS NULL
  ORDER  BY score DESC
  LIMIT  ?
`);

const stmtPostsByKeyword = _db.prepare(`
  SELECT p.*
  FROM   keywords k
  JOIN   posts p ON p.id = k.post_id
  WHERE  k.keyword = ?
  ORDER  BY k.score DESC, p.ts DESC
  LIMIT  ?
`);

const stmtPrune = _db.prepare(`
  DELETE FROM posts WHERE ts < ?
`);

const stmtPruneKeywords = _db.prepare(`
  DELETE FROM keywords WHERE ts < ?
`);

const stmtUpsertAccount = _db.prepare(`
  INSERT INTO accounts
    (username, post_count, avg_score, avg_velocity, top_keywords, first_seen, last_seen, follow_score, followed)
  VALUES
    (@username, @post_count, @avg_score, @avg_velocity, @top_keywords, @first_seen, @last_seen, @follow_score, 0)
  ON CONFLICT(username) DO UPDATE SET
    post_count   = @post_count,
    avg_score    = @avg_score,
    avg_velocity = @avg_velocity,
    top_keywords = @top_keywords,
    last_seen    = @last_seen,
    follow_score = @follow_score
`);

const stmtFollowCandidates = _db.prepare(`
  SELECT * FROM accounts
  WHERE  post_count >= @min_posts
    AND  avg_score  >= @min_score
    AND  followed   = 0
  ORDER  BY follow_score DESC
  LIMIT  @limit
`);

const stmtMarkFollowed = _db.prepare(`
  UPDATE accounts
  SET    followed = 1, followed_at = @followed_at
  WHERE  username = @username
`);

const stmtGetAccount = _db.prepare(`
  SELECT * FROM accounts WHERE username = @username
`);

const stmtPostsInWindow = _db.prepare(`
  SELECT keywords FROM posts
  WHERE  ts > @from_ts AND ts <= @to_ts AND parent_id IS NULL
`);

const stmtInsertMemory = _db.prepare(`
  INSERT OR IGNORE INTO memory
    (type, date, hour, title, text_content, keywords, file_path, indexed_at)
  VALUES
    (@type, @date, @hour, @title, @text_content, @keywords, @file_path, @indexed_at)
`);

const stmtUpdateMemoryTxId = _db.prepare(`
  UPDATE memory SET tx_id = @tx_id WHERE file_path = @file_path
`);

const stmtSearchMemory = _db.prepare(`
  SELECT m.*, bm25(memory_fts) AS rank
  FROM   memory_fts
  JOIN   memory m ON m.id = memory_fts.id
  WHERE  memory_fts MATCH ?
  ORDER  BY rank
  LIMIT  ?
`);

const stmtGetMemoryByPath = _db.prepare(`
  SELECT * FROM memory WHERE file_path = @file_path
`);

const stmtRecentMemory = _db.prepare(`
  SELECT * FROM memory
  WHERE  (@type IS NULL OR type = @type)
  ORDER  BY date DESC, hour DESC
  LIMIT  @limit
`);

// ── Public API ────────────────────────────────────────────────────────────────

/** Insert or replace a post (upsert). */
function insertPost(row) {
  stmtInsertPost.run({
    id:           row.id,
    ts:           row.ts,
    ts_iso:       row.ts_iso,
    username:     row.username,
    display_name: row.display_name || null,
    text:         row.text,
    likes:        row.likes    || 0,
    rts:          row.rts      || 0,
    replies:      row.replies  || 0,
    velocity:     row.velocity || 0,
    trust:        row.trust    || 0,
    score:        row.score    || 0,
    keywords:     row.keywords || "",
    parent_id:    row.parent_id || null,
    scraped_at:   row.scraped_at || Date.now(),
  });
}

/** Insert or replace a keyword→post link. */
function insertKeyword({ post_id, keyword, score }) {
  stmtInsertKeyword.run({ keyword, post_id, score: score || 0 });
}

/**
 * Full-text search via FTS5.
 * query: FTS5 match expression, e.g. "AI automation" or "\"attention economy\""
 */
function search(query, limit = 20) {
  return stmtSearch.all(query, limit);
}

/**
 * Top keywords in the last N hours, sorted by frequency.
 * Returns [{keyword, count, avg_score, last_seen}]
 */
function topKeywords(hours = 24, limit = 30) {
  const since = Date.now() - hours * 3_600_000;
  return stmtTopKeywords.all(since, limit);
}

/**
 * Recent top-scored posts (no replies) in the last N hours.
 */
function recentPosts(hours = 24, limit = 50) {
  const since = Date.now() - hours * 3_600_000;
  return stmtRecentPosts.all(since, limit);
}

/**
 * All posts tagged with a specific keyword.
 */
function postsByKeyword(keyword, limit = 20) {
  return stmtPostsByKeyword.all(keyword, limit);
}

/**
 * Prune posts and keywords older than PRUNE_DAYS days.
 */
function prune() {
  const cutoff = Date.now() - PRUNE_DAYS * 86_400_000;
  const r1 = stmtPrune.run(cutoff);
  const r2 = stmtPruneKeywords.run(cutoff);
  return { posts: r1.changes, keywords: r2.changes };
}

/**
 * Upsert per-account stats (rolling averages, top keywords, follow_score).
 * Called by collect.js after each collect run.
 */
function upsertAccount(row) {
  stmtUpsertAccount.run({
    username:     row.username,
    post_count:   row.post_count   || 0,
    avg_score:    row.avg_score    || 0,
    avg_velocity: row.avg_velocity || 0,
    top_keywords: row.top_keywords || "",
    first_seen:   row.first_seen   || Date.now(),
    last_seen:    row.last_seen    || Date.now(),
    follow_score: row.follow_score || 0,
  });
}

/**
 * Return follow candidates: accounts seen ≥ minPosts times,
 * avg_score ≥ minScore, not yet followed, sorted by follow_score DESC.
 */
function followCandidates(minPosts = 2, minScore = 5.0, limit = 20) {
  return stmtFollowCandidates.all({ min_posts: minPosts, min_score: minScore, limit });
}

/** Mark an account as followed (sets followed=1, followed_at=now). */
function markFollowed(username) {
  stmtMarkFollowed.run({ username, followed_at: Date.now() });
}

/** Fetch a single account row, or undefined if not found. */
function getAccount(username) {
  return stmtGetAccount.get({ username });
}

/**
 * Return keywords fields for all non-reply posts within a time window.
 * Used by analytics.detectBursts() to compare two windows.
 */
function postsInWindow(fromMs, toMs) {
  return stmtPostsInWindow.all({ from_ts: fromMs, to_ts: toMs });
}

/**
 * Insert a memory entry (idempotent on file_path — INSERT OR IGNORE).
 * Called by archive.js for each new journal/checkpoint/report file.
 */
function insertMemory(row) {
  stmtInsertMemory.run({
    type:         row.type,
    date:         row.date,
    hour:         row.hour ?? null,
    title:        row.title,
    text_content: row.text_content,
    keywords:     row.keywords || "",
    file_path:    row.file_path,
    indexed_at:   row.indexed_at || Date.now(),
  });
}

/** Set the Arweave TX ID on a memory entry after successful upload. */
function updateMemoryTxId(filePath, txId) {
  stmtUpdateMemoryTxId.run({ tx_id: txId, file_path: filePath });
}

/**
 * FTS5 full-text search over memory entries.
 * Returns ranked results (best match first).
 */
function recallMemory(query, limit = 5) {
  // Sanitize FTS5 special chars
  const safe = query.replace(/["*()\-]/g, " ").trim();
  if (!safe) return [];
  return stmtSearchMemory.all(safe, limit);
}

/** Get a single memory row by file path (used for dedup check). */
function getMemoryByPath(filePath) {
  return stmtGetMemoryByPath.get({ file_path: filePath });
}

/**
 * Recent memory entries, optionally filtered by type.
 * @param {string|null} type - null = all types
 * @param {number} limit
 */
function recentMemory(type = null, limit = 10) {
  return stmtRecentMemory.all({ type: type ?? null, limit });
}

// ── Embedding statements ───────────────────────────────────────────────────────
const stmtStoreEmbedding = _db.prepare(`
  INSERT OR REPLACE INTO embeddings (entity_type, entity_id, vector, embedded_at)
  VALUES (@entity_type, @entity_id, @vector, @embedded_at)
`);

const stmtGetEmbedding = _db.prepare(`
  SELECT vector FROM embeddings WHERE entity_type = @entity_type AND entity_id = @entity_id
`);

const stmtAllEmbeddings = _db.prepare(`
  SELECT entity_id, vector FROM embeddings WHERE entity_type = @entity_type
`);

const stmtEmbeddingIds = _db.prepare(`
  SELECT entity_id FROM embeddings WHERE entity_type = @entity_type
`);

/**
 * Store or replace an embedding vector for an entity.
 * @param {string} entityType - 'post' | 'memory' | 'evidence'
 * @param {string} entityId   - post id, memory id, or compound key
 * @param {number[]} vector   - embedding as flat number array
 */
function storeEmbedding(entityType, entityId, vector) {
  stmtStoreEmbedding.run({
    entity_type:  entityType,
    entity_id:    String(entityId),
    vector:       JSON.stringify(vector),
    embedded_at:  Date.now(),
  });
}

/**
 * Retrieve the embedding vector for an entity, or null if not found.
 */
function getEmbedding(entityType, entityId) {
  const row = stmtGetEmbedding.get({ entity_type: entityType, entity_id: String(entityId) });
  return row ? JSON.parse(row.vector) : null;
}

/**
 * Return all embeddings of a given entity type.
 * Returns [{entity_id, vector}] with vector already parsed.
 */
function allEmbeddings(entityType) {
  return stmtAllEmbeddings.all({ entity_type: entityType })
    .map(r => ({ entity_id: r.entity_id, vector: JSON.parse(r.vector) }));
}

/**
 * Return all entity_ids that already have embeddings of a given type.
 */
function embeddedIds(entityType) {
  return new Set(stmtEmbeddingIds.all({ entity_type: entityType }).map(r => r.entity_id));
}

/** Raw db handle for advanced queries. */
function raw() { return _db; }

module.exports = {
  insertPost, insertKeyword, search, topKeywords, recentPosts, postsByKeyword, prune,
  upsertAccount, followCandidates, markFollowed, getAccount, postsInWindow,
  insertMemory, updateMemoryTxId, recallMemory, getMemoryByPath, recentMemory,
  storeEmbedding, getEmbedding, allEmbeddings, embeddedIds,
  raw,
};
