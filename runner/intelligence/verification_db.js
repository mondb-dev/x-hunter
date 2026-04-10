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

// ── Migrate: add columns if they don't exist (for existing DBs) ───────────
try {
  const cols = db.pragma('table_info(claim_verifications)').map(c => c.name);
  if (!cols.includes('original_source'))    db.exec('ALTER TABLE claim_verifications ADD COLUMN original_source TEXT');
  if (!cols.includes('claim_date'))         db.exec('ALTER TABLE claim_verifications ADD COLUMN claim_date TEXT');
  if (!cols.includes('supporting_sources')) db.exec('ALTER TABLE claim_verifications ADD COLUMN supporting_sources TEXT');
  if (!cols.includes('dissenting_sources')) db.exec('ALTER TABLE claim_verifications ADD COLUMN dissenting_sources TEXT');
  if (!cols.includes('framing_analysis'))   db.exec('ALTER TABLE claim_verifications ADD COLUMN framing_analysis TEXT');
} catch {}

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

function parseRow(row) {
  row.scoring_breakdown = row.scoring_breakdown ? JSON.parse(row.scoring_breakdown) : {};
  row.evidence_urls = row.evidence_urls ? JSON.parse(row.evidence_urls) : [];
  row.supporting_sources = row.supporting_sources ? JSON.parse(row.supporting_sources) : [];
  row.dissenting_sources = row.dissenting_sources ? JSON.parse(row.dissenting_sources) : [];
  return row;
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
  runTransaction,
};
