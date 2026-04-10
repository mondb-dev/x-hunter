/**
 * runner/intelligence/verification_db.pg.js — Postgres claim verification helpers
 *
 * Async replacement for verification_db.js (better-sqlite3).
 * Same function signatures, all return Promises.
 */

'use strict';

const { query, transaction } = require('../lib/pg');

// ── Upsert a claim verification ─────────────────────────────────────────────

async function upsertVerification(record) {
  const now = new Date().toISOString();
  await query(`
    INSERT INTO claim_verifications (
      claim_id, claim_source, claim_text, confidence_score, scoring_breakdown,
      status, verification_count, last_verified_at, web_search_summary,
      evidence_urls, source_handle, source_tier, related_axis_id, category,
      original_source, claim_date, supporting_sources, dissenting_sources, framing_analysis,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, 1, $7, $8,
      $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18,
      $19, $20
    )
    ON CONFLICT(claim_id) DO UPDATE SET
      confidence_score   = $4,
      scoring_breakdown  = $5,
      status             = $6,
      verification_count = claim_verifications.verification_count + 1,
      last_verified_at   = $7,
      web_search_summary = COALESCE($8, claim_verifications.web_search_summary),
      evidence_urls      = COALESCE($9, claim_verifications.evidence_urls),
      original_source    = COALESCE($14, claim_verifications.original_source),
      claim_date         = COALESCE($15, claim_verifications.claim_date),
      supporting_sources = COALESCE($16, claim_verifications.supporting_sources),
      dissenting_sources = COALESCE($17, claim_verifications.dissenting_sources),
      framing_analysis   = COALESCE($18, claim_verifications.framing_analysis),
      updated_at         = $20
  `, [
    record.claim_id,
    record.claim_source,
    record.claim_text,
    record.confidence_score,
    JSON.stringify(record.scoring_breakdown),
    record.status,
    now,
    record.web_search_summary || null,
    record.evidence_urls ? JSON.stringify(record.evidence_urls) : null,
    record.source_handle || null,
    record.source_tier || null,
    record.related_axis_id || null,
    record.category || null,
    record.original_source || null,
    record.claim_date || null,
    record.supporting_sources ? JSON.stringify(record.supporting_sources) : null,
    record.dissenting_sources ? JSON.stringify(record.dissenting_sources) : null,
    record.framing_analysis || null,
    record.created_at || now,
    now,
  ]);
}

// ── Audit log ───────────────────────────────────────────────────────────────

async function logAudit(record) {
  await query(`
    INSERT INTO claim_audit_log (
      claim_id, claim_source, old_status, new_status,
      confidence_score, scoring_breakdown, verification_method,
      evidence_urls, notes, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    record.claim_id,
    record.claim_source,
    record.old_status || null,
    record.new_status,
    record.confidence_score,
    JSON.stringify(record.scoring_breakdown),
    record.verification_method || 'auto_score',
    record.evidence_urls ? JSON.stringify(record.evidence_urls) : null,
    record.notes || null,
    new Date().toISOString(),
  ]);
}

// ── Reads ───────────────────────────────────────────────────────────────────

function parseRow(row) {
  if (!row) return null;
  row.scoring_breakdown = row.scoring_breakdown ? JSON.parse(row.scoring_breakdown) : {};
  row.evidence_urls = row.evidence_urls ? JSON.parse(row.evidence_urls) : [];
  row.supporting_sources = row.supporting_sources ? JSON.parse(row.supporting_sources) : [];
  row.dissenting_sources = row.dissenting_sources ? JSON.parse(row.dissenting_sources) : [];
  return row;
}

async function getVerification(claimId) {
  const { rows } = await query(
    'SELECT * FROM claim_verifications WHERE claim_id = $1', [claimId]
  );
  return parseRow(rows[0]) || null;
}

async function getUnverified() {
  const { rows } = await query(
    "SELECT * FROM claim_verifications WHERE status IN ('unverified', 'contested') ORDER BY confidence_score DESC"
  );
  return rows.map(parseRow);
}

async function getAllVerifications() {
  const { rows } = await query(`
    SELECT * FROM claim_verifications ORDER BY
      CASE status
        WHEN 'supported' THEN 1
        WHEN 'refuted'   THEN 2
        WHEN 'contested' THEN 3
        WHEN 'unverified' THEN 4
        WHEN 'expired'   THEN 5
      END,
      confidence_score DESC
  `);
  return rows.map(parseRow);
}

async function getAuditLog(claimId) {
  const { rows } = await query(
    'SELECT * FROM claim_audit_log WHERE claim_id = $1 ORDER BY created_at DESC', [claimId]
  );
  return rows.map(row => {
    row.scoring_breakdown = row.scoring_breakdown ? JSON.parse(row.scoring_breakdown) : {};
    row.evidence_urls = row.evidence_urls ? JSON.parse(row.evidence_urls) : [];
    return row;
  });
}

async function markTweetPosted(claimId, tweetUrl) {
  await query(
    'UPDATE claim_verifications SET tweet_posted = 1, tweet_url = $1, updated_at = $2 WHERE claim_id = $3',
    [tweetUrl, new Date().toISOString(), claimId]
  );
}

async function markExpired(claimId) {
  const existing = await getVerification(claimId);
  await query(
    "UPDATE claim_verifications SET status = 'expired', updated_at = $1 WHERE claim_id = $2",
    [new Date().toISOString(), claimId]
  );
  if (existing) {
    await logAudit({
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

/**
 * Run upserts + audit logs in a single transaction.
 * @param {Function} fn — async callback, receives no args
 */
async function runTransaction(fn) {
  return transaction(async () => {
    await fn();
  });
}

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
