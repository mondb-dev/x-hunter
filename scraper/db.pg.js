/**
 * scraper/db.pg.js — Postgres version of the scraper index DB
 *
 * Async replacement for db.js (better-sqlite3 + FTS5).
 * FTS5 is replaced by Postgres tsvector + GIN index.
 * Same exported function names, all return Promises.
 */

'use strict';

const { query, transaction } = require('../runner/lib/pg');

const PRUNE_DAYS = 7;

// ── Posts ────────────────────────────────────────────────────────────────────

async function insertPost(row) {
  await query(`
    INSERT INTO posts
      (id, ts, ts_iso, username, display_name, text, likes, rts, replies,
       velocity, trust, score, novelty, keywords, external_urls, external_domains,
       parent_id, scraped_at, media_type, media_description)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20)
    ON CONFLICT(id) DO UPDATE SET
      ts = $2, ts_iso = $3, username = $4, display_name = $5, text = $6,
      likes = $7, rts = $8, replies = $9, velocity = $10, trust = $11,
      score = $12, novelty = $13, keywords = $14, external_urls = $15,
      external_domains = $16, parent_id = $17, scraped_at = $18,
      media_type = $19, media_description = $20
  `, [
    row.id, row.ts, row.ts_iso, row.username, row.display_name || null,
    row.text, row.likes || 0, row.rts || 0, row.replies || 0,
    row.velocity || 0, row.trust || 0, row.score || 0, row.novelty || 0,
    row.keywords || '', JSON.stringify(row.external_urls || []),
    JSON.stringify(row.external_domains || []),
    row.parent_id || null, row.scraped_at || Date.now(),
    row.media_type || 'none', row.media_description || '',
  ]);
}

async function updateMediaDescription(id, description) {
  await query('UPDATE posts SET media_description = $1 WHERE id = $2', [description || '', id]);
}

// ── Keywords ────────────────────────────────────────────────────────────────

async function insertKeyword({ post_id, keyword, score }) {
  await query(`
    INSERT INTO keywords (keyword, post_id, score, ts)
    VALUES ($1, $2, $3, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT)
    ON CONFLICT(keyword, post_id) DO UPDATE SET
      score = $3, ts = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
  `, [keyword, post_id, score || 0]);
}

// ── Full-text search (replaces FTS5 MATCH) ──────────────────────────────────

/**
 * Full-text search via Postgres tsvector.
 * Replaces FTS5 MATCH + bm25() with plainto_tsquery + ts_rank.
 */
async function search(queryStr, limit = 20) {
  const safe = queryStr.replace(/["*()\-]/g, ' ').trim();
  if (!safe) return [];
  const { rows } = await query(`
    SELECT p.*, ts_rank(p.tsv, plainto_tsquery('english', $1)) AS rank
    FROM posts p
    WHERE p.tsv @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC
    LIMIT $2
  `, [safe, limit]);
  return rows;
}

async function topKeywords(hours = 24, limit = 30) {
  const since = Date.now() - hours * 3_600_000;
  const { rows } = await query(`
    SELECT keyword,
           COUNT(*)   AS count,
           AVG(score) AS avg_score,
           MAX(ts)    AS last_seen
    FROM keywords
    WHERE ts > $1
    GROUP BY keyword
    ORDER BY count DESC, avg_score DESC
    LIMIT $2
  `, [since, limit]);
  return rows;
}

async function recentPosts(hours = 24, limit = 50) {
  const since = Date.now() - hours * 3_600_000;
  const { rows } = await query(`
    SELECT * FROM posts
    WHERE ts > $1 AND parent_id IS NULL
    ORDER BY score DESC
    LIMIT $2
  `, [since, limit]);
  return rows;
}

async function postsByKeyword(keyword, limit = 20) {
  const { rows } = await query(`
    SELECT p.*
    FROM keywords k
    JOIN posts p ON p.id = k.post_id
    WHERE k.keyword = $1
    ORDER BY k.score DESC, p.ts DESC
    LIMIT $2
  `, [keyword, limit]);
  return rows;
}

async function topNovelPosts(hours = 4, limit = 10) {
  const since = Date.now() - hours * 3_600_000;
  const { rows } = await query(`
    SELECT * FROM posts
    WHERE ts > $1 AND parent_id IS NULL AND novelty > 0
    ORDER BY novelty DESC
    LIMIT $2
  `, [since, limit]);
  return rows;
}

async function prune() {
  const cutoff = Date.now() - PRUNE_DAYS * 86_400_000;
  const r1 = await query('DELETE FROM posts WHERE ts < $1', [cutoff]);
  const r2 = await query('DELETE FROM keywords WHERE ts < $1', [cutoff]);
  return { posts: r1.rowCount, keywords: r2.rowCount };
}

// ── Accounts ────────────────────────────────────────────────────────────────

async function upsertAccount(row) {
  await query(`
    INSERT INTO accounts
      (username, post_count, avg_score, avg_velocity, top_keywords, first_seen, last_seen, follow_score, followed)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
    ON CONFLICT(username) DO UPDATE SET
      post_count   = $2,
      avg_score    = $3,
      avg_velocity = $4,
      top_keywords = $5,
      last_seen    = $7,
      follow_score = $8
  `, [
    row.username, row.post_count || 0, row.avg_score || 0,
    row.avg_velocity || 0, row.top_keywords || '',
    row.first_seen || Date.now(), row.last_seen || Date.now(),
    row.follow_score || 0,
  ]);
}

async function followCandidates(minPosts = 2, minScore = 5.0, limit = 20) {
  const { rows } = await query(`
    SELECT * FROM accounts
    WHERE post_count >= $1 AND avg_score >= $2 AND followed = 0
    ORDER BY follow_score DESC
    LIMIT $3
  `, [minPosts, minScore, limit]);
  return rows;
}

async function markFollowed(username) {
  await query(
    'UPDATE accounts SET followed = 1, followed_at = $1 WHERE username = $2',
    [Date.now(), username]
  );
}

async function getAccount(username) {
  const { rows } = await query('SELECT * FROM accounts WHERE username = $1', [username]);
  return rows[0] || undefined;
}

async function getPostById(id) {
  const { rows } = await query('SELECT * FROM posts WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) return undefined;
  try { row.external_urls = JSON.parse(row.external_urls || '[]'); } catch { row.external_urls = []; }
  try { row.external_domains = JSON.parse(row.external_domains || '[]'); } catch { row.external_domains = []; }
  return row;
}

async function postsByUser(username, limit = 5) {
  const { rows } = await query(`
    SELECT text, keywords, external_urls, external_domains FROM posts
    WHERE username = $1 AND parent_id IS NULL
    ORDER BY ts DESC LIMIT $2
  `, [username, limit]);
  return rows;
}

async function postsInWindow(fromMs, toMs) {
  const { rows } = await query(`
    SELECT keywords FROM posts
    WHERE ts > $1 AND ts <= $2 AND parent_id IS NULL
  `, [fromMs, toMs]);
  return rows;
}

// ── Memory ──────────────────────────────────────────────────────────────────

async function insertMemory(row) {
  await query(`
    INSERT INTO memory (type, date, hour, title, text_content, keywords, file_path, indexed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT(file_path) DO NOTHING
  `, [
    row.type, row.date, row.hour ?? null, row.title,
    row.text_content, row.keywords || '', row.file_path,
    row.indexed_at || Date.now(),
  ]);
}

async function updateMemoryTxId(filePath, txId) {
  await query('UPDATE memory SET tx_id = $1 WHERE file_path = $2', [txId, filePath]);
}

/**
 * Full-text search over memory entries (replaces FTS5 MATCH + bm25).
 */
async function recallMemory(queryStr, limit = 5) {
  const safe = queryStr.replace(/["*()\-]/g, ' ').trim();
  if (!safe) return [];
  const { rows } = await query(`
    SELECT m.*, ts_rank(m.tsv, plainto_tsquery('english', $1)) AS rank
    FROM memory m
    WHERE m.tsv @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC
    LIMIT $2
  `, [safe, limit]);
  return rows;
}

async function getMemoryByPath(filePath) {
  const { rows } = await query('SELECT * FROM memory WHERE file_path = $1', [filePath]);
  return rows[0] || undefined;
}

async function recentMemory(type = null, limit = 10) {
  const { rows } = await query(`
    SELECT * FROM memory
    WHERE ($1::TEXT IS NULL OR type = $1)
    ORDER BY date DESC, hour DESC
    LIMIT $2
  `, [type, limit]);
  return rows;
}

// ── Embeddings ──────────────────────────────────────────────────────────────

async function storeEmbedding(entityType, entityId, vector) {
  await query(`
    INSERT INTO embeddings (entity_type, entity_id, vector, embedded_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      vector = $3, embedded_at = $4
  `, [entityType, String(entityId), JSON.stringify(vector), Date.now()]);
}

async function getEmbedding(entityType, entityId) {
  const { rows } = await query(
    'SELECT vector FROM embeddings WHERE entity_type = $1 AND entity_id = $2',
    [entityType, String(entityId)]
  );
  return rows[0] ? JSON.parse(rows[0].vector) : null;
}

async function allEmbeddings(entityType) {
  const { rows } = await query(
    'SELECT entity_id, vector FROM embeddings WHERE entity_type = $1',
    [entityType]
  );
  return rows.map(r => ({ entity_id: r.entity_id, vector: JSON.parse(r.vector) }));
}

async function embeddedIds(entityType) {
  const { rows } = await query(
    'SELECT entity_id FROM embeddings WHERE entity_type = $1',
    [entityType]
  );
  return new Set(rows.map(r => r.entity_id));
}

// ── FTS health (no-op in Postgres — tsvector is always consistent) ──────────

async function checkAndHealFts() {
  return { healthy: true, rebuilt: false, checks: [], errors: [] };
}

async function rebuildFtsIfNeeded() {
  return false;
}

// ── Raw pool access for advanced queries ────────────────────────────────────

function raw() {
  return require('../runner/lib/pg').pool;
}

module.exports = {
  insertPost, insertKeyword, search, topKeywords, recentPosts, postsByKeyword, prune,
  topNovelPosts, updateMediaDescription,
  upsertAccount, followCandidates, markFollowed, getAccount, postsByUser, postsInWindow,
  getPostById,
  insertMemory, updateMemoryTxId, recallMemory, getMemoryByPath, recentMemory,
  storeEmbedding, getEmbedding, allEmbeddings, embeddedIds,
  checkAndHealFts,
  rebuildFtsIfNeeded,
  raw,
};
