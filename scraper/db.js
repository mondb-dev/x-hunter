"use strict";
/**
 * scraper/db.js — SQLite index for scraped posts
 *
 * Schema:
 *   posts       — every post with metadata + RAKE keywords
 *   posts_fts   — FTS5 virtual table over (username, text, keywords)
 *   keywords    — inverted index: keyword → post_ids with scores
 *
 * The FTS5 table enables full-text queries like:
 *   db.search("automation AI") → ranked post rows
 *
 * The keywords table enables aggregate queries like:
 *   db.topKeywords(24) → [{keyword, count, avg_score}]
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

/** Raw db handle for advanced queries. */
function raw() { return _db; }

module.exports = { insertPost, insertKeyword, search, topKeywords, recentPosts, postsByKeyword, prune, raw };
