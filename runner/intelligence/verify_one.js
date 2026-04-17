#!/usr/bin/env node
/**
 * runner/intelligence/verify_one.js — on-demand single-claim verification
 *
 * Called by the agent when an interaction (reply, trending post, QT) contains
 * a claim worth fact-checking. Performs priority verification with web search,
 * persists to claim_verifications (official claims list), exports for web,
 * and prints a JSON result to stdout for the caller to use in a tweet/reply.
 *
 * Usage:
 *   node runner/intelligence/verify_one.js --claim "The claim text here"
 *   node runner/intelligence/verify_one.js --claim "..." --source-handle @user --source-url https://x.com/...
 *   node runner/intelligence/verify_one.js --claim "..." --category diplomatic --axis axis_geopolitical_rhetoric_v1
 *
 * Exits 0 with JSON on stdout: { claim_id, status, confidence, summary, verdict_label, lens_url }
 * Exits 1 on fatal error (stderr).
 *
 * Uses BUILDER_CREDENTIALS (separate SA) to avoid rate-limit contention.
 */

'use strict';

const crypto = require('crypto');
const config = require('../lib/config');
const { loadVerificationDb } = require('../lib/db_backend');

const { scoreClaim }              = require('./claim_scorer');
const { webSearchVerify }         = require('./lib/web_search');
const { exportVerificationData, filterStableUrls } = require('./lib/verification_export');
const { loadSourceData }          = require('./lib/source_data');

const vdb = loadVerificationDb();

function log(msg) { console.error(`[verify_one] ${msg}`); }

// ── Parse args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--claim'         && args[i+1]) { opts.claim         = args[++i]; continue; }
    if (args[i] === '--source-handle' && args[i+1]) { opts.sourceHandle  = args[++i]; continue; }
    if (args[i] === '--source-url'    && args[i+1]) { opts.sourceUrl     = args[++i]; continue; }
    if (args[i] === '--category'      && args[i+1]) { opts.category      = args[++i]; continue; }
    if (args[i] === '--axis'          && args[i+1]) { opts.axis          = args[++i]; continue; }
    if (args[i] === '--source-tier'   && args[i+1]) { opts.sourceTier    = parseInt(args[++i], 10); continue; }
    if (args[i] === '--dry-run')                     { opts.dryRun       = true; continue; }
  }
  return opts;
}

// ── Generate stable claim ID ────────────────────────────────────────────────

function makeClaimId(text) {
  const hash = crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 10);
  return `live_${hash}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs();
  if (!opts.claim) {
    console.error('Usage: verify_one.js --claim "claim text" [--source-handle @user] [--source-url url] [--category cat] [--axis axis_id]');
    process.exit(1);
  }

  const claimText  = opts.claim.trim();
  const claimId    = makeClaimId(claimText);
  const handle     = opts.sourceHandle?.replace(/^@/, '') || null;
  const sourceData = await loadSourceData(handle, null, config.STATE_DIR);

  log(`verifying: "${claimText.slice(0, 80)}..." (id=${claimId})`);

  // 1. Check if already verified recently
  const existing = vdb.getVerification(claimId);
  if (existing && existing.web_search_summary) {
    const age = Date.now() - new Date(existing.last_verified_at || 0).getTime();
    if (age < 6 * 3600_000) {
      log(`recently verified (${Math.round(age / 60_000)}m ago), returning cached`);
      const verdictLabel = existing.status === 'supported' ? 'Supported'
        : existing.status === 'refuted' ? 'Refuted'
        : existing.status === 'contested' ? 'Contested'
        : 'Unverified';
      console.log(JSON.stringify({
        claim_id:      claimId,
        status:        existing.status,
        confidence:    existing.confidence_score,
        summary:       existing.web_search_summary,
        verdict_label: verdictLabel,
        lens_url:      `https://sebastianhunter.fun/veritas-lens#${claimId}`,
        cached:        true,
      }));
      return;
    }
  }

  // 2. Web search (always — this is priority verification)
  log('running web search...');
  const searchData = await webSearchVerify(claimText);

  if (!searchData) {
    log('web search failed, scoring without it');
  }

  // 3. Score
  const claimObj = {
    claim_id:            claimId,
    claim_text:          claimText,
    claim_source:        'live',
    source_handle:       handle,
    source_tier:         opts.sourceTier || null,
    corroborating_count: 0,
    contradicting_count: 0,
    cited_url:           opts.sourceUrl || null,
    cited_domain:        null,
    web_search_result:   searchData?.web_search_result || null,
    evidence_urls:       searchData?.evidence_urls || [],
    category:            opts.category || null,
    related_axis_id:     opts.axis || null,
  };

  const result = scoreClaim(claimObj, sourceData);
  log(`score: ${result.confidence.toFixed(3)} → ${result.suggested_status}`);

  // 4. Persist
  if (!opts.dryRun) {
    const stableUrls = filterStableUrls(searchData?.evidence_urls);

    vdb.upsertVerification({
      claim_id:           claimId,
      claim_source:       'live',
      claim_text:         claimText,
      confidence_score:   result.confidence,
      scoring_breakdown:  result.breakdown,
      status:             result.suggested_status,
      web_search_summary: searchData?.summary || null,
      evidence_urls:      stableUrls.length ? stableUrls : null,
      source_handle:      handle,
      source_tier:        opts.sourceTier || null,
      related_axis_id:    opts.axis || null,
      category:           opts.category || null,
      original_source:    searchData?.original_source || null,
      claim_date:         searchData?.claim_date || null,
      supporting_sources: searchData?.supporting_sources || null,
      dissenting_sources: searchData?.dissenting_sources || null,
      framing_analysis:   searchData?.framing_analysis || null,
      created_at:         existing?.created_at || new Date().toISOString(),
    });

    vdb.logAudit({
      claim_id:            claimId,
      claim_source:        'live',
      old_status:          existing?.status || null,
      new_status:          result.suggested_status,
      confidence_score:    result.confidence,
      scoring_breakdown:   result.breakdown,
      verification_method: 'live_web_search',
      evidence_urls:       searchData?.evidence_urls || null,
      notes:               searchData?.summary || `Live verification: ${result.confidence.toFixed(3)}`,
    });

    // 5. Re-export for web
    exportVerificationData(vdb, config.VERIFICATION_EXPORT_PATH);
  }

  // 6. Output for caller
  const verdictLabel = result.suggested_status === 'supported' ? 'Supported'
    : result.suggested_status === 'refuted' ? 'Refuted'
    : result.suggested_status === 'contested' ? 'Contested'
    : 'Unverified';

  console.log(JSON.stringify({
    claim_id:      claimId,
    status:        result.suggested_status,
    confidence:    result.confidence,
    summary:       searchData?.summary || null,
    verdict_label: verdictLabel,
    lens_url:      `https://sebastianhunter.fun/veritas-lens#${claimId}`,
    evidence_urls: filterStableUrls(searchData?.evidence_urls).slice(0, 3),
    framing:       searchData?.framing_analysis || null,
    cached:        false,
  }));
}

run().catch(err => {
  console.error(`[verify_one] fatal: ${err.message}`);
  process.exit(1);
});
