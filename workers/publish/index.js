#!/usr/bin/env node
/**
 * workers/publish/index.js — Publish worker (Cloud Run HTTP service)
 *
 * Stateless service that handles post-verification publishing tasks:
 *   - Receives claim-resolved events from Pub/Sub push subscription
 *   - Generates tweet draft text for resolved claims
 *   - Writes draft to Postgres for VM pickup (VM owns browser/CDP posting)
 *   - Generates verification export JSON for the /verified web page
 *   - Handles GCS sync of verification data
 *
 * The VM's post_browse.js checks for pending verification drafts each cycle
 * and posts them via browser CDP — we don't duplicate browser logic here.
 *
 * Endpoints:
 *   POST /claim-resolved   — Pub/Sub push handler (claim resolution event)
 *   POST /export           — Regenerate verification_export.json + sync to GCS
 *   POST /generate-draft   — Generate tweet draft for a specific claim
 *   GET  /health           — Health check
 *
 * Env vars:
 *   DATABASE_URL           — Postgres connection string
 *   GCP_PROJECT            — GCP project ID
 *   GCS_DATA_BUCKET        — GCS bucket for data sync (default: sebastian-hunter-data)
 *   PG_SSL                 — set to 'false' for same-VPC connections
 */

'use strict';

const http = require('http');
const { Storage } = require('@google-cloud/storage');

// ── Structured logging (Cloud Logging format) ──────────────────────────────
function structLog(severity, message, fields = {}) {
  const entry = {
    severity,
    message,
    component: 'publish-worker',
    ...fields,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(entry));
}
const log = {
  info: (msg, f) => structLog('INFO', msg, f),
  warn: (msg, f) => structLog('WARNING', msg, f),
  error: (msg, f) => structLog('ERROR', msg, f),
};

// ── DB setup ────────────────────────────────────────────────────────────────

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function query(text, params = []) {
  return pool.query(text, params);
}

// ── GCS ─────────────────────────────────────────────────────────────────────

const storage = new Storage({ projectId: process.env.GCP_PROJECT || 'sebastian-hunter' });
const bucket = storage.bucket(process.env.GCS_DATA_BUCKET || 'sebastian-hunter-data');

async function uploadToGCS(remotePath, content) {
  const file = bucket.file(remotePath);
  await file.save(content, { contentType: 'application/json', resumable: false });
  log.info('uploaded to GCS', { path: remotePath });
}

// ── Draft generation ────────────────────────────────────────────────────────

/**
 * Generate a tweet-ready draft for a resolved claim.
 * Format matches what postVerificationTweet() in post.js expects.
 */
function generateDraft(claim) {
  const status = claim.status;
  const conf = Math.round((claim.confidence_score || 0) * 100);
  const emoji = status === 'supported' ? 'Supported' : 'Refuted';

  // Truncate claim text for tweet
  let claimText = (claim.claim_text || '').trim();
  const maxClaim = 100;
  if (claimText.length > maxClaim) {
    claimText = claimText.slice(0, maxClaim - 3) + '...';
  }

  const webUrl = 'https://sebastianhunter.fun/verified';

  let summary = '';
  if (claim.web_search_summary) {
    summary = claim.web_search_summary.trim();
    // Keep summary concise for tweet
    const maxSummary = 280 - claimText.length - webUrl.length - 80;
    if (summary.length > maxSummary && maxSummary > 20) {
      summary = summary.slice(0, maxSummary - 3) + '...';
    }
  }

  // Build source attribution
  let sources = '';
  if (claim.source_handle) {
    sources = `Source: ${claim.source_handle}`;
    if (claim.source_tier) sources += ` (Tier ${claim.source_tier})`;
  }

  const lines = [
    `Claim check: "${claimText}"`,
    '',
    `Verdict: ${emoji} (${conf}% confidence)`,
  ];

  if (summary) lines.push('', summary);
  if (sources) lines.push('', sources);
  lines.push(webUrl);

  return lines.join('\n');
}

// ── Pub/Sub claim-resolved handler ──────────────────────────────────────────

async function handleClaimResolved(event) {
  const { claim_id, new_status } = event;
  if (!claim_id) throw new Error('missing claim_id in event');

  log.info('claim-resolved event', { claim_id, new_status });

  // Only generate drafts for terminal statuses
  if (new_status !== 'supported' && new_status !== 'refuted') {
    log.info('non-terminal status, skipping draft', { new_status });
    return { action: 'skipped', reason: 'non-terminal status' };
  }

  // Load full claim from DB
  const { rows } = await query(
    'SELECT * FROM claim_verifications WHERE claim_id = $1',
    [claim_id]
  );
  if (!rows[0]) throw new Error(`claim ${claim_id} not found in DB`);

  const claim = rows[0];

  // Check if already tweeted
  if (claim.tweet_posted) {
    log.info('already tweeted, skipping', { claim_id });
    return { action: 'skipped', reason: 'already tweeted' };
  }

  // Generate draft
  const draft = generateDraft(claim);
  log.info('draft generated', { claim_id, chars: draft.length });

  // Store draft in Postgres for VM pickup
  await query(`
    INSERT INTO pending_drafts (draft_type, claim_id, content, created_at)
    VALUES ('verification', $1, $2, $3)
    ON CONFLICT (draft_type, claim_id) DO UPDATE SET
      content = $2, created_at = $3
  `, [claim_id, draft, new Date().toISOString()]);

  log.info('draft stored for VM pickup', { claim_id });

  // Also regenerate the export
  await generateExport();

  return { action: 'draft_created', claim_id, draft_length: draft.length };
}

// ── Export generation ───────────────────────────────────────────────────────

async function generateExport() {
  const { rows: claims } = await query(`
    SELECT * FROM claim_verifications ORDER BY
      CASE status WHEN 'supported' THEN 1 WHEN 'refuted' THEN 2 WHEN 'contested' THEN 3
        WHEN 'unverified' THEN 4 WHEN 'expired' THEN 5 END,
      confidence_score DESC
  `);

  const stats = { total: claims.length, supported: 0, refuted: 0, contested: 0, unverified: 0, expired: 0 };
  for (const c of claims) {
    if (stats[c.status] !== undefined) stats[c.status]++;
  }

  const exportData = {
    generated_at: new Date().toISOString(),
    stats,
    claims: claims.map(c => ({
      claim_id: c.claim_id,
      claim_text: c.claim_text,
      status: c.status,
      confidence_score: c.confidence_score,
      scoring_breakdown: c.scoring_breakdown ? JSON.parse(c.scoring_breakdown) : {},
      source_handle: c.source_handle,
      source_tier: c.source_tier,
      evidence_urls: c.evidence_urls ? JSON.parse(c.evidence_urls) : [],
      supporting_sources: c.supporting_sources ? JSON.parse(c.supporting_sources) : [],
      dissenting_sources: c.dissenting_sources ? JSON.parse(c.dissenting_sources) : [],
      framing_analysis: c.framing_analysis,
      tweet_url: c.tweet_url,
      tweet_posted: !!c.tweet_posted,
      category: c.category,
      original_source: c.original_source,
      claim_date: c.claim_date,
      web_search_summary: c.web_search_summary,
      verified_at: c.last_verified_at,
      created_at: c.created_at,
    })),
  };

  const json = JSON.stringify(exportData, null, 2);

  // Upload to GCS for Cloud Run site
  await uploadToGCS('state/verification_export.json', json);

  log.info('export generated', { total: stats.total, supported: stats.supported, refuted: stats.refuted, contested: stats.contested });
  return exportData;
}

// ── Generate draft for specific claim ───────────────────────────────────────

async function handleGenerateDraft(claimId) {
  const { rows } = await query(
    'SELECT * FROM claim_verifications WHERE claim_id = $1',
    [claimId]
  );
  if (!rows[0]) throw new Error(`claim ${claimId} not found`);

  const claim = rows[0];
  const draft = generateDraft(claim);

  await query(`
    INSERT INTO pending_drafts (draft_type, claim_id, content, created_at)
    VALUES ('verification', $1, $2, $3)
    ON CONFLICT (draft_type, claim_id) DO UPDATE SET
      content = $2, created_at = $3
  `, [claimId, draft, new Date().toISOString()]);

  return { claim_id: claimId, draft };
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url;
  const method = req.method;

  try {
    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Pub/Sub push handler — wraps message in standard envelope
    if (method === 'POST' && url === '/claim-resolved') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const envelope = JSON.parse(body);

      // Pub/Sub push sends { message: { data: base64, ... }, subscription: ... }
      let event;
      if (envelope.message?.data) {
        event = JSON.parse(Buffer.from(envelope.message.data, 'base64').toString());
      } else {
        // Direct invocation (Cloud Tasks or testing)
        event = envelope;
      }

      const result = await handleClaimResolved(event);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (method === 'POST' && url === '/export') {
      const exportData = await generateExport();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats: exportData.stats }));
      return;
    }

    if (method === 'POST' && url === '/generate-draft') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { claim_id } = JSON.parse(body);
      const result = await handleGenerateDraft(claim_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    log.error('request handler error', { error: err.message, stack: err.stack });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
  log.info('worker started', { port: PORT });
});
