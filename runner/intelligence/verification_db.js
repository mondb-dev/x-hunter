#!/usr/bin/env node
/**
 * runner/intelligence/verification_db.js — claim verification DB helpers
 *
 * Extends intelligence.db with claim_verifications and claim_audit_log tables.
 * Provides CRUD helpers used by verify_claims.js.
 *
 * Uses the same better-sqlite3 singleton from db.js.
 */

'use strict';

const db = require('./db');

// ── Schema (idempotent) ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS claim_verifications (
    claim_id            TEXT PRIMARY KEY,
    claim_source        TEXT NOT NULL,
    claim_text          TEXT NOT NULL,
    confidence_score    REAL NOT NULL,
    scoring_breakdown   TEXT,
    status              TEXT NOT NULL DEFAULT 'unverified',
    verification_count  INTEGER DEFAULT 0,
    last_verified_at    TEXT,
    web_search_summary  TEXT,
    evidence_urls       TEXT,
    tweet_posted        INTEGER DEFAULT 0,
    tweet_url           TEXT,
    source_handle       TEXT,
    source_tier         INTEGER,
    related_axis_id     TEXT,
    category            TEXT,
    original_source     TEXT,
    claim_date          TEXT,
    supporting_sources  TEXT,
    dissenting_sources  TEXT,
    framing_analysis    TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS claim_audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id            TEXT NOT NULL,
    claim_source        TEXT NOT NULL,
    old_status          TEXT,
    new_status          TEXT NOT NULL,
    confidence_score    REAL,
    scoring_breakdown   TEXT,
    verification_method TEXT,
    evidence_urls       TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cv_status ON claim_verifications(status);
  CREATE INDEX IF NOT EXISTS idx_cv_score  ON claim_verifications(confidence_score);
  CREATE INDEX IF NOT EXISTS idx_audit_claim ON claim_audit_log(claim_id);
`);

// ── Schema migrations (idempotent) ─────────────────────────────────────────
for (const col of [
  "ALTER TABLE claim_verifications ADD COLUMN watch_tweet_url TEXT",
  "ALTER TABLE claim_verifications ADD COLUMN watch_posted_at TEXT",
  "ALTER TABLE claim_verifications ADD COLUMN resolution_tweet_url TEXT",
  "ALTER TABLE claim_verifications ADD COLUMN resolution_posted_at TEXT",
]) {
  try { db.exec(col); } catch {} // SQLITE_ERROR = column exists — safe to ignore
}

db.exec(`

  CREATE VIRTUAL TABLE IF NOT EXISTS cv_fts USING fts5(
    claim_id UNINDEXED,
    claim_text,
    web_search_summary,
    claim_source,
    content='claim_verifications',
    content_rowid='rowid'
  );
`);

// ── FTS5 sync triggers for claim_verifications ───────────────────────────────
try {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS cv_ai AFTER INSERT ON claim_verifications BEGIN
      INSERT INTO cv_fts(rowid, claim_id, claim_text, web_search_summary, claim_source)
      VALUES (new.rowid, new.claim_id, new.claim_text,
              COALESCE(new.web_search_summary, ''), new.claim_source);
    END;
    CREATE TRIGGER IF NOT EXISTS cv_au AFTER UPDATE ON claim_verifications BEGIN
      INSERT INTO cv_fts(cv_fts, rowid, claim_id, claim_text, web_search_summary, claim_source)
      VALUES ('delete', old.rowid, old.claim_id, old.claim_text,
              COALESCE(old.web_search_summary, ''), old.claim_source);
      INSERT INTO cv_fts(rowid, claim_id, claim_text, web_search_summary, claim_source)
      VALUES (new.rowid, new.claim_id, new.claim_text,
              COALESCE(new.web_search_summary, ''), new.claim_source);
    END;
    CREATE TRIGGER IF NOT EXISTS cv_ad AFTER DELETE ON claim_verifications BEGIN
      INSERT INTO cv_fts(cv_fts, rowid, claim_id, claim_text, web_search_summary, claim_source)
      VALUES ('delete', old.rowid, old.claim_id, old.claim_text,
              COALESCE(old.web_search_summary, ''), old.claim_source);
    END;
  `);
  // Populate FTS index from existing rows
  db.exec(`INSERT INTO cv_fts(cv_fts) VALUES('rebuild')`);
} catch { /* already consistent */ }

// ── Migrate: add columns if they don't exist (for existing DBs) ───────────
try {
  const cols = db.pragma('table_info(claim_verifications)').map(c => c.name);
  if (!cols.includes('original_source'))    db.exec('ALTER TABLE claim_verifications ADD COLUMN original_source TEXT');
  if (!cols.includes('claim_date'))         db.exec('ALTER TABLE claim_verifications ADD COLUMN claim_date TEXT');
  if (!cols.includes('supporting_sources')) db.exec('ALTER TABLE claim_verifications ADD COLUMN supporting_sources TEXT');
  if (!cols.includes('dissenting_sources')) db.exec('ALTER TABLE claim_verifications ADD COLUMN dissenting_sources TEXT');
  if (!cols.includes('framing_analysis'))   db.exec('ALTER TABLE claim_verifications ADD COLUMN framing_analysis TEXT');
  if (!cols.includes('investigation_id'))   db.exec('ALTER TABLE claim_verifications ADD COLUMN investigation_id TEXT');
  if (!cols.includes('investigation_depth')) db.exec("ALTER TABLE claim_verifications ADD COLUMN investigation_depth TEXT DEFAULT 'quick'");
} catch {}

// ── Investigation table (deep research results) ─────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS claim_investigations (
    investigation_id      TEXT PRIMARY KEY,
    claim_id              TEXT NOT NULL,
    claim_text            TEXT NOT NULL,
    sub_questions         TEXT,
    attribution_chain     TEXT,
    supporting_evidence   TEXT,
    contradicting_evidence TEXT,
    overall_verdict       TEXT,
    confidence            REAL,
    summary               TEXT,
    key_finding           TEXT,
    raw_result            TEXT,
    turns_used            INTEGER,
    duration_seconds      INTEGER,
    created_at            TEXT NOT NULL,
    FOREIGN KEY (claim_id) REFERENCES claim_verifications(claim_id)
  );
  CREATE INDEX IF NOT EXISTS idx_inv_claim ON claim_investigations(claim_id);
`);

// ── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  upsertVerification: db.prepare(`
    INSERT INTO claim_verifications (
      claim_id, claim_source, claim_text, confidence_score, scoring_breakdown,
      status, verification_count, last_verified_at, web_search_summary,
      evidence_urls, source_handle, source_tier, related_axis_id, category,
      original_source, claim_date, supporting_sources, dissenting_sources, framing_analysis,
      created_at, updated_at
    ) VALUES (
      @claim_id, @claim_source, @claim_text, @confidence_score, @scoring_breakdown,
      @status, 1, @last_verified_at, @web_search_summary,
      @evidence_urls, @source_handle, @source_tier, @related_axis_id, @category,
      @original_source, @claim_date, @supporting_sources, @dissenting_sources, @framing_analysis,
      @created_at, @updated_at
    )
    ON CONFLICT(claim_id) DO UPDATE SET
      confidence_score   = @confidence_score,
      scoring_breakdown  = @scoring_breakdown,
      status             = @status,
      verification_count = verification_count + 1,
      last_verified_at   = @last_verified_at,
      web_search_summary = COALESCE(@web_search_summary, claim_verifications.web_search_summary),
      evidence_urls      = COALESCE(@evidence_urls, claim_verifications.evidence_urls),
      original_source    = COALESCE(@original_source, claim_verifications.original_source),
      claim_date         = COALESCE(@claim_date, claim_verifications.claim_date),
      supporting_sources = COALESCE(@supporting_sources, claim_verifications.supporting_sources),
      dissenting_sources = COALESCE(@dissenting_sources, claim_verifications.dissenting_sources),
      framing_analysis   = COALESCE(@framing_analysis, claim_verifications.framing_analysis),
      updated_at         = @updated_at
  `),

  insertAudit: db.prepare(`
    INSERT INTO claim_audit_log (
      claim_id, claim_source, old_status, new_status,
      confidence_score, scoring_breakdown, verification_method,
      evidence_urls, notes, created_at
    ) VALUES (
      @claim_id, @claim_source, @old_status, @new_status,
      @confidence_score, @scoring_breakdown, @verification_method,
      @evidence_urls, @notes, @created_at
    )
  `),

  getVerification: db.prepare(`
    SELECT * FROM claim_verifications WHERE claim_id = ?
  `),

  getUnverified: db.prepare(`
    SELECT * FROM claim_verifications WHERE status IN ('unverified', 'contested')
    ORDER BY confidence_score DESC
  `),

  getAllVerifications: db.prepare(`
    SELECT * FROM claim_verifications ORDER BY
      CASE status
        WHEN 'supported' THEN 1
        WHEN 'refuted'   THEN 2
        WHEN 'contested' THEN 3
        WHEN 'unverified' THEN 4
        WHEN 'expired'   THEN 5
      END,
      confidence_score DESC
  `),

  getAuditLog: db.prepare(`
    SELECT * FROM claim_audit_log WHERE claim_id = ? ORDER BY created_at DESC
  `),

  markTweetPosted: db.prepare(`
    UPDATE claim_verifications SET tweet_posted = 1, tweet_url = ?, updated_at = ? WHERE claim_id = ?
  `),

  markExpired: db.prepare(`
    UPDATE claim_verifications SET status = 'expired', updated_at = ? WHERE claim_id = ?
  `),

  setWatchTweetUrl: db.prepare(`
    UPDATE claim_verifications
    SET watch_tweet_url = ?, watch_posted_at = ?, updated_at = ?
    WHERE claim_id = ?
  `),

  setResolutionTweetUrl: db.prepare(`
    UPDATE claim_verifications
    SET resolution_tweet_url = ?, resolution_posted_at = ?, updated_at = ?
    WHERE claim_id = ?
  `),

  // Candidates for watch-signal: unverified, has a source URL to quote, not yet watch-posted
  getWatchCandidates: db.prepare(`
    SELECT * FROM claim_verifications
    WHERE  status = 'unverified'
      AND  watch_tweet_url IS NULL
      AND  confidence_score >= 0.45
      AND  related_axis_id IS NOT NULL
      AND  source_handle IS NOT NULL
      AND  original_source IS NOT NULL
    ORDER  BY confidence_score DESC
    LIMIT  10
  `),

  // Candidates for resolution post: verdict in, confidence high, watch tweet exists
  getResolutionCandidates: db.prepare(`
    SELECT * FROM claim_verifications
    WHERE  status IN ('supported', 'refuted')
      AND  confidence_score >= 0.65
      AND  watch_tweet_url IS NOT NULL
      AND  resolution_tweet_url IS NULL
    ORDER  BY confidence_score DESC
    LIMIT  10
  `),

  // ── Investigation statements ──────────────────────────────────────────────
  insertInvestigation: db.prepare(`
    INSERT INTO claim_investigations (
      investigation_id, claim_id, claim_text, sub_questions, attribution_chain,
      supporting_evidence, contradicting_evidence, overall_verdict, confidence,
      summary, key_finding, raw_result, turns_used, duration_seconds, created_at
    ) VALUES (
      @investigation_id, @claim_id, @claim_text, @sub_questions, @attribution_chain,
      @supporting_evidence, @contradicting_evidence, @overall_verdict, @confidence,
      @summary, @key_finding, @raw_result, @turns_used, @duration_seconds, @created_at
    )
  `),

  getInvestigation: db.prepare(`
    SELECT * FROM claim_investigations WHERE investigation_id = ?
  `),

  getInvestigationByClaim: db.prepare(`
    SELECT * FROM claim_investigations WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1
  `),

  linkInvestigation: db.prepare(`
    UPDATE claim_verifications
    SET investigation_id = ?, investigation_depth = 'deep', updated_at = ?
    WHERE claim_id = ?
  `),
};

// ── Public helpers ──────────────────────────────────────────────────────────

/**
 * Upsert a claim verification result.
 * If the claim already exists, increments verification_count and updates scores.
 */
function upsertVerification(record) {
  const now = new Date().toISOString();
  stmts.upsertVerification.run({
    claim_id:           record.claim_id,
    claim_source:       record.claim_source,
    claim_text:         record.claim_text,
    confidence_score:   record.confidence_score,
    scoring_breakdown:  JSON.stringify(record.scoring_breakdown),
    status:             record.status,
    last_verified_at:   now,
    web_search_summary: record.web_search_summary || null,
    evidence_urls:      record.evidence_urls ? JSON.stringify(record.evidence_urls) : null,
    source_handle:      record.source_handle || null,
    source_tier:        record.source_tier || null,
    related_axis_id:    record.related_axis_id || null,
    category:           record.category || null,
    original_source:    record.original_source || null,
    claim_date:         record.claim_date || null,
    supporting_sources: record.supporting_sources ? JSON.stringify(record.supporting_sources) : null,
    dissenting_sources: record.dissenting_sources ? JSON.stringify(record.dissenting_sources) : null,
    framing_analysis:   record.framing_analysis || null,
    created_at:         record.created_at || now,
    updated_at:         now,
  });
}

/**
 * Log a status transition in the audit trail.
 */
function logAudit(record) {
  stmts.insertAudit.run({
    claim_id:            record.claim_id,
    claim_source:        record.claim_source,
    old_status:          record.old_status || null,
    new_status:          record.new_status,
    confidence_score:    record.confidence_score,
    scoring_breakdown:   JSON.stringify(record.scoring_breakdown),
    verification_method: record.verification_method || 'auto_score',
    evidence_urls:       record.evidence_urls ? JSON.stringify(record.evidence_urls) : null,
    notes:               record.notes || null,
    created_at:          new Date().toISOString(),
  });
}

function getVerification(claimId) {
  const row = stmts.getVerification.get(claimId);
  if (row) {
    row.scoring_breakdown = row.scoring_breakdown ? JSON.parse(row.scoring_breakdown) : {};
    row.evidence_urls = row.evidence_urls ? JSON.parse(row.evidence_urls) : [];
  }
  return row || null;
}

function getUnverified() {
  return stmts.getUnverified.all().map(parseRow);
}

function getAllVerifications() {
  return stmts.getAllVerifications.all().map(parseRow);
}

function getAuditLog(claimId) {
  return stmts.getAuditLog.all(claimId).map(row => {
    row.scoring_breakdown = row.scoring_breakdown ? JSON.parse(row.scoring_breakdown) : {};
    row.evidence_urls = row.evidence_urls ? JSON.parse(row.evidence_urls) : [];
    return row;
  });
}

function markTweetPosted(claimId, tweetUrl) {
  stmts.markTweetPosted.run(tweetUrl, new Date().toISOString(), claimId);
}

function markExpired(claimId) {
  const existing = getVerification(claimId);
  stmts.markExpired.run(new Date().toISOString(), claimId);
  if (existing) {
    logAudit({
      claim_id: claimId,
      claim_source: existing.claim_source,
      old_status: existing.status,
      new_status: 'expired',
      confidence_score: existing.confidence_score,
      scoring_breakdown: existing.scoring_breakdown,
      verification_method: 'lifecycle',
      notes: 'Claim expired without resolution',
    });
  }
}

function setWatchTweetUrl(claimId, url) {
  const now = new Date().toISOString();
  stmts.setWatchTweetUrl.run(url, now, now, claimId);
}

function setResolutionTweetUrl(claimId, url) {
  const now = new Date().toISOString();
  stmts.setResolutionTweetUrl.run(url, now, now, claimId);
}

function getWatchCandidates() {
  return stmts.getWatchCandidates.all().map(parseRow);
}

function getResolutionCandidates() {
  return stmts.getResolutionCandidates.all().map(parseRow);
}

function insertInvestigation(record) {
  stmts.insertInvestigation.run({
    investigation_id:      record.investigation_id,
    claim_id:              record.claim_id,
    claim_text:            record.claim_text,
    sub_questions:         JSON.stringify(record.sub_questions || []),
    attribution_chain:     JSON.stringify(record.attribution_chain || []),
    supporting_evidence:   JSON.stringify(record.supporting_evidence || []),
    contradicting_evidence: JSON.stringify(record.contradicting_evidence || []),
    overall_verdict:       record.overall_verdict || 'inconclusive',
    confidence:            record.confidence || 0,
    summary:               record.summary || '',
    key_finding:           record.key_finding || '',
    raw_result:            JSON.stringify(record.raw_result || {}),
    turns_used:            record.turns_used || 0,
    duration_seconds:      record.duration_seconds || 0,
    created_at:            record.created_at || new Date().toISOString(),
  });
}

function getInvestigation(investigationId) {
  const row = stmts.getInvestigation.get(investigationId);
  return row ? parseInvestigation(row) : null;
}

function getInvestigationByClaim(claimId) {
  const row = stmts.getInvestigationByClaim.get(claimId);
  return row ? parseInvestigation(row) : null;
}

function linkInvestigation(claimId, investigationId) {
  stmts.linkInvestigation.run(investigationId, new Date().toISOString(), claimId);
}

function parseInvestigation(row) {
  try { row.sub_questions = JSON.parse(row.sub_questions || '[]'); } catch { row.sub_questions = []; }
  try { row.attribution_chain = JSON.parse(row.attribution_chain || '[]'); } catch { row.attribution_chain = []; }
  try { row.supporting_evidence = JSON.parse(row.supporting_evidence || '[]'); } catch { row.supporting_evidence = []; }
  try { row.contradicting_evidence = JSON.parse(row.contradicting_evidence || '[]'); } catch { row.contradicting_evidence = []; }
  try { row.raw_result = JSON.parse(row.raw_result || '{}'); } catch { row.raw_result = {}; }
  return row;
}

function parseRow(row) {
  row.scoring_breakdown = row.scoring_breakdown ? JSON.parse(row.scoring_breakdown) : {};
  row.evidence_urls = row.evidence_urls ? JSON.parse(row.evidence_urls) : [];
  row.supporting_sources = row.supporting_sources ? JSON.parse(row.supporting_sources) : [];
  row.dissenting_sources = row.dissenting_sources ? JSON.parse(row.dissenting_sources) : [];
  return row;
}

/**
 * FTS5 full-text search over claim_text + web_search_summary.
 * Returns rows ordered by BM25 relevance, shaped for recall.js formatting.
 * @param {string} queryStr
 * @param {number} limit
 * @returns {Array}
 */
function recallVerifications(queryStr, limit = 5) {
  const safe = queryStr.replace(/["*()\-]/g, ' ').trim();
  if (!safe) return [];
  try {
    return db.prepare(`
      SELECT cv.*,
             bm25(cv_fts) AS rank
      FROM   cv_fts
      JOIN   claim_verifications cv ON cv.rowid = cv_fts.rowid
      WHERE  cv_fts MATCH ?
      ORDER  BY rank
      LIMIT  ?
    `).all(safe, limit).map(parseRow);
  } catch (e) {
    if (e.code === 'SQLITE_CORRUPT_VTAB') {
      try { db.exec(`INSERT INTO cv_fts(cv_fts) VALUES('rebuild')`); } catch {}
      try {
        return db.prepare(`
          SELECT cv.*, bm25(cv_fts) AS rank
          FROM   cv_fts
          JOIN   claim_verifications cv ON cv.rowid = cv_fts.rowid
          WHERE  cv_fts MATCH ?
          ORDER  BY rank LIMIT ?
        `).all(safe, limit).map(parseRow);
      } catch { return []; }
    }
    return [];
  }
}

/**
 * Run all upserts + audit logs in a single transaction.
 * @param {Function} fn — callback receiving no args; call upsertVerification/logAudit inside
 */
const runTransaction = db.transaction((fn) => fn());

module.exports = {
  upsertVerification,
  logAudit,
  getVerification,
  getUnverified,
  getAllVerifications,
  getAuditLog,
  markTweetPosted,
  markExpired,
  setWatchTweetUrl,
  setResolutionTweetUrl,
  getWatchCandidates,
  getResolutionCandidates,
  insertInvestigation,
  getInvestigation,
  getInvestigationByClaim,
  linkInvestigation,
  recallVerifications,
  runTransaction,
};
