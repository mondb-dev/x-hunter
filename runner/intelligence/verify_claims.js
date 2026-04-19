#!/usr/bin/env node
/**
 * runner/intelligence/verify_claims.js — batch claim verification pipeline
 *
 * Runs periodically via systemd timer (every 2h).
 * Scores unverified/contested claims, runs web searches on top priority,
 * updates statuses, writes audit trail, and exports for web.
 *
 * Non-fatal: exits 0 on any error to avoid blocking the pipeline.
 *
 * Usage:
 *   node runner/intelligence/verify_claims.js              # normal
 *   node runner/intelligence/verify_claims.js --dry-run    # score + print, no writes
 */

'use strict';

const fs   = require('fs');
const config = require('../lib/config');
const { loadIntelligenceDb, loadVerificationDb, usePostgres } = require('../lib/db_backend');

const { scoreClaim }              = require('./claim_scorer');
const { webSearchVerify }         = require('./lib/web_search');
const { exportVerificationData }  = require('./lib/verification_export');
const { loadSourceData }          = require('./lib/source_data');
const { investigateClaimSync }    = require('../lib/verify_claim');
const { syncToGCS }               = require('../lib/git');

const idb = loadIntelligenceDb();
const vdb = loadVerificationDb();
const DB_IS_PG = usePostgres();

const isDryRun = process.argv.includes('--dry-run');

function log(msg) { console.log(`[verify_claims] ${msg}`); }

// ── Configuration ───────────────────────────────────────────────────────────
const MAX_CLAIMS_PER_CYCLE   = 10;
const WEB_SEARCH_PER_CYCLE   = 3;
const STALE_HOURS            = 48;
const MAX_INVESTIGATIONS_PER_DAY = 2;
const INVESTIGATION_COOLDOWN_MS  = 12 * 3600_000; // 12h between investigations
const EXPIRY_RULES = {
  military_action:         72,
  casualties_humanitarian: 72,
  threats_claims:          72,
  nuclear:                 168,
  diplomatic:              168,
  proxy_regional:          168,
  internal_politics:       720,
  misc:                    720,
};
const DEFAULT_EXPIRY_HOURS = 720;

// ── Load claims from both sources ───────────────────────────────────────────

function loadTrackerClaims() {
  try {
    const data = JSON.parse(fs.readFileSync(config.CLAIM_TRACKER_PATH, 'utf-8'));
    return (data.claims || []).map(c => ({
      ...c,
      claim_source: 'tracker',
      corroborating_count: c.corroborating_count || 0,
      contradicting_count: c.contradicting_count || 0,
    }));
  } catch {
    return [];
  }
}

async function loadIntelligenceClaims() {
  try {
    let rows;
    if (DB_IS_PG) {
      const result = await idb.query(`
        SELECT id as claim_id, claim_text, source_handle, source_url,
               source_tier, source_ng_score, category, axis_id as related_axis_id,
               has_supporting_url, corroborating_count, contradicting_count,
               status, observed_at as created_at
        FROM claims
        WHERE status IN ('unverified', 'contested')
        ORDER BY corroborating_count DESC
        LIMIT 50
      `);
      rows = result.rows;
    } else {
      rows = idb.prepare(`
        SELECT id as claim_id, claim_text, source_handle, source_url,
               source_tier, source_ng_score, category, axis_id as related_axis_id,
               has_supporting_url, corroborating_count, contradicting_count,
               status, observed_at as created_at
        FROM claims
        WHERE status IN ('unverified', 'contested')
        ORDER BY corroborating_count DESC
        LIMIT 50
      `).all();
    }
    return rows.map(r => ({
      ...r,
      id: r.claim_id,
      claim_source: 'intelligence',
      cited_url: r.has_supporting_url ? r.source_url : null,
      cited_domain: null,
    }));
  } catch {
    return [];
  }
}

function handleFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/x\.com\/([^/]+)/);
  return match ? match[1].toLowerCase() : null;
}

// ── Priority scoring ────────────────────────────────────────────────────────

function prioritize(claims) {
  const now = Date.now();
  return claims.map(c => {
    let priority = 0;
    const age = now - new Date(c.created_at || 0).getTime();
    if (age < 6 * 3600_000) priority += 30;
    priority += Math.min((c.corroborating_count || 0) * 5, 20);
    if (age > STALE_HOURS * 3600_000) priority += 10;
    if (c.claim_source === 'tracker') priority += 5;
    if (c.cited_url) priority += 5;
    return { ...c, _priority: priority };
  }).sort((a, b) => b._priority - a._priority);
}

// ── Verification draft for tweeting ─────────────────────────────────────────

function writeVerificationDraft(claim, result, searchData) {
  const truncatedClaim = claim.claim_text.length > 100
    ? claim.claim_text.slice(0, 97) + '...'
    : claim.claim_text;

  const verdictLabel = result.suggested_status === 'supported' ? 'Supported'
    : result.suggested_status === 'refuted' ? 'Refuted'
    : 'Contested';

  const confidencePct = Math.round(result.confidence * 100);

  const sourceLine = searchData?.key_sources?.length
    ? `Sources: ${searchData.key_sources.slice(0, 3).join(', ')}`
    : '';

  const lines = [
    `Claim check: "${truncatedClaim}"`,
    '',
    `Verdict: ${verdictLabel} (${confidencePct}% confidence)`,
    '',
    searchData?.summary || '',
    '',
    sourceLine,
    'https://sebastianhunter.fun/veritas-lens',
  ].filter(l => l !== undefined);

  const draft = lines.join('\n').trim();

  if (!isDryRun) {
    fs.writeFileSync(config.VERIFICATION_DRAFT_PATH, draft, 'utf-8');
    log(`verification draft written (${verdictLabel}, ${confidencePct}%)`);
  } else {
    log(`[dry-run] would write draft: ${verdictLabel} ${confidencePct}%`);
  }
}

// ── Claim lifecycle (expiry) ────────────────────────────────────────────────

function processExpiry() {
  const now = Date.now();
  const all = vdb.getAllVerifications();
  let expired = 0;

  for (const claim of all) {
    if (claim.status === 'expired' || claim.status === 'supported' || claim.status === 'refuted') continue;
    const expiryHours = EXPIRY_RULES[claim.category] || DEFAULT_EXPIRY_HOURS;
    const age = now - new Date(claim.created_at).getTime();
    if (age > expiryHours * 3600_000) {
      if (!isDryRun) {
        vdb.markExpired(claim.claim_id);
      }
      expired++;
    }
  }

  if (expired > 0) log(`expired ${expired} stale claims`);
}

// ── Update claim_tracker.json for tracker-sourced claims ────────────────────

function updateTrackerClaim(claimId, newStatus, notes) {
  try {
    const data = JSON.parse(fs.readFileSync(config.CLAIM_TRACKER_PATH, 'utf-8'));
    const claim = (data.claims || []).find(c => c.id === claimId);
    if (!claim) return;
    claim.status = newStatus;
    claim.notes = claim.notes ? claim.notes + ' | ' + notes : notes;
    claim.updated_at = new Date().toISOString();
    data.updated_at = new Date().toISOString();
    fs.writeFileSync(config.CLAIM_TRACKER_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    log(`tracker update error: ${err.message}`);
  }
}

// ── Persist helpers ─────────────────────────────────────────────────────────

const { filterStableUrls } = require('./lib/verification_export');

function persistResult({ claim, result, handle, oldStatus }) {
  const searchData = claim._searchData;
  const statusChanged = result.suggested_status !== oldStatus;

  vdb.upsertVerification({
    claim_id:           claim.claim_id,
    claim_source:       claim.claim_source,
    claim_text:         claim.claim_text,
    confidence_score:   result.confidence,
    scoring_breakdown:  result.breakdown,
    status:             result.suggested_status,
    web_search_summary: searchData?.summary || null,
    evidence_urls:      filterStableUrls(searchData?.evidence_urls).length ? filterStableUrls(searchData?.evidence_urls) : null,
    source_handle:      handle || claim.source_handle || null,
    source_tier:        claim.source_tier || null,
    related_axis_id:    claim.related_axis_id || null,
    category:           claim.category || null,
    original_source:    searchData?.original_source || null,
    claim_date:         searchData?.claim_date || null,
    supporting_sources: searchData?.supporting_sources || null,
    dissenting_sources: searchData?.dissenting_sources || null,
    framing_analysis:   searchData?.framing_analysis || null,
    created_at:         claim.created_at,
  });

  if (statusChanged) {
    vdb.logAudit({
      claim_id:            claim.claim_id,
      claim_source:        claim.claim_source,
      old_status:          oldStatus,
      new_status:          result.suggested_status,
      confidence_score:    result.confidence,
      scoring_breakdown:   result.breakdown,
      verification_method: searchData ? 'web_search' : 'auto_score',
      evidence_urls:       searchData?.evidence_urls || null,
      notes:               searchData?.summary || `Auto-scored: ${result.confidence.toFixed(3)}`,
    });

    if (claim.claim_source === 'tracker' && result.suggested_status !== 'unverified') {
      const note = searchData
        ? `[auto-verified] ${result.suggested_status} (${Math.round(result.confidence * 100)}%): ${searchData.summary?.slice(0, 100) || ''}`
        : `[auto-scored] ${result.suggested_status} (${Math.round(result.confidence * 100)}%)`;
      updateTrackerClaim(claim.claim_id, result.suggested_status, note);
      log(`tracker updated: ${claim.claim_id} → ${result.suggested_status}`);
    }
  }
}

// ── Deep investigation cadence ──────────────────────────────────────────────

const INVESTIGATION_STATE_PATH = require('path').join(config.STATE_DIR, 'investigation_state.json');

function loadInvestigationState() {
  try {
    return JSON.parse(fs.readFileSync(INVESTIGATION_STATE_PATH, 'utf-8'));
  } catch {
    return { last_investigation_at: null, today_count: 0, today_date: null };
  }
}

function saveInvestigationState(state) {
  fs.writeFileSync(INVESTIGATION_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

async function maybeInvestigate(results) {
  const state = loadInvestigationState();
  const today = new Date().toISOString().slice(0, 10);

  // Reset daily counter
  if (state.today_date !== today) {
    state.today_count = 0;
    state.today_date = today;
  }

  if (state.today_count >= MAX_INVESTIGATIONS_PER_DAY) {
    log(`investigation: daily limit reached (${state.today_count}/${MAX_INVESTIGATIONS_PER_DAY})`);
    return;
  }

  // Cooldown check
  if (state.last_investigation_at) {
    const elapsed = Date.now() - new Date(state.last_investigation_at).getTime();
    if (elapsed < INVESTIGATION_COOLDOWN_MS) {
      const hoursLeft = ((INVESTIGATION_COOLDOWN_MS - elapsed) / 3600_000).toFixed(1);
      log(`investigation: cooldown active (${hoursLeft}h remaining)`);
      return;
    }
  }

  // Find best candidate: contested or unverified with web search done but no deep investigation
  const candidates = results
    .filter(r => {
      const status = r.result.suggested_status;
      if (status !== 'contested' && status !== 'unverified') return false;
      // Must have had a web search (otherwise too early)
      if (!r.claim._searchData) return false;
      // Must not already be deep-investigated
      const existing = vdb.getVerification(r.claim.claim_id);
      if (existing?.investigation_depth === 'deep') return false;
      return true;
    })
    .sort((a, b) => {
      // Prefer contested over unverified
      const aContested = a.result.suggested_status === 'contested' ? 1 : 0;
      const bContested = b.result.suggested_status === 'contested' ? 1 : 0;
      if (bContested !== aContested) return bContested - aContested;
      // Then by priority
      return (b.claim._priority || 0) - (a.claim._priority || 0);
    });

  if (candidates.length === 0) {
    log('investigation: no eligible candidates this cycle');
    return;
  }

  const pick = candidates[0];
  log(`investigation: starting deep investigation for "${(pick.claim.claim_text || '').slice(0, 80)}"`);

  const invResult = investigateClaimSync({
    claim: pick.claim.claim_text,
    claimId: pick.claim.claim_id,
    handle: pick.handle,
    category: pick.claim.category,
    tier: pick.claim.source_tier,
  });

  if (invResult) {
    log(`investigation: completed — ${invResult.status} (${Math.round((invResult.confidence || 0) * 100)}%), ${invResult.supporting || 0} supporting, ${invResult.contradicting || 0} contradicting`);
    // Re-export since investigate_claim.js already persisted
    exportVerificationData(vdb, config.VERIFICATION_EXPORT_PATH);
  } else {
    log('investigation: failed or timed out');
  }

  state.last_investigation_at = new Date().toISOString();
  state.today_count++;
  saveInvestigationState(state);
}

// ── Main pipeline ───────────────────────────────────────────────────────────

async function run() {
  log('starting verification pipeline' + (isDryRun ? ' (dry-run)' : ''));

  // 1. Load claims from both sources
  const trackerClaims = loadTrackerClaims()
    .filter(c => c.status === 'unverified' || c.status === 'contested');
  const intelClaims = await loadIntelligenceClaims();

  // Deduplicate by claim_id (tracker takes precedence)
  const seen = new Set();
  const allClaims = [];
  for (const c of trackerClaims) {
    const key = c.id || c.claim_id;
    if (!seen.has(key)) { seen.add(key); allClaims.push({ ...c, claim_id: key }); }
  }
  for (const c of intelClaims) {
    const key = c.id || c.claim_id;
    if (!seen.has(key)) { seen.add(key); allClaims.push({ ...c, claim_id: key }); }
  }

  if (allClaims.length === 0) {
    log('no unverified claims to process');
    if (!isDryRun) {
      exportVerificationData(vdb, config.VERIFICATION_EXPORT_PATH);
      syncToGCS();
    }
    return;
  }

  log(`loaded ${allClaims.length} unverified/contested claims (${trackerClaims.length} tracker, ${intelClaims.length} intel)`);

  // 2. Prioritize and limit
  const prioritized = prioritize(allClaims).slice(0, MAX_CLAIMS_PER_CYCLE);

  // 3. Score all claims
  let webSearchCount = 0;
  const results = [];

  for (const claim of prioritized) {
    const handle = claim.source_handle || handleFromUrl(claim.source_url || claim.source_post_url);
    const sourceData = await loadSourceData(handle, idb, config.STATE_DIR, DB_IS_PG);

    const existing = vdb.getVerification(claim.claim_id);
    if (existing?.web_search_summary && !claim.web_search_result) {
      const prevBreakdown = existing.scoring_breakdown || {};
      claim.web_search_result = prevBreakdown.web_search > 0 ? prevBreakdown.web_search : null;
    }

    const result = scoreClaim(claim, sourceData);
    const oldStatus = existing?.status || claim.status || 'unverified';

    if (isDryRun) {
      log(`  ${claim.claim_id}: ${result.confidence.toFixed(3)} → ${result.suggested_status} (was: ${oldStatus}) | "${(claim.claim_text || '').slice(0, 60)}"`);
    }

    results.push({ claim, result, sourceData, handle, oldStatus });
  }

  // 4. Web search on top priority claims not recently searched
  for (const { claim, result, sourceData, handle, oldStatus } of results) {
    if (webSearchCount >= WEB_SEARCH_PER_CYCLE) break;

    const existing = vdb.getVerification(claim.claim_id);
    if (existing?.web_search_summary && existing?.last_verified_at) {
      const lastVerified = new Date(existing.last_verified_at).getTime();
      if (Date.now() - lastVerified < 24 * 3600_000) continue;
    }

    log(`web searching: "${(claim.claim_text || '').slice(0, 80)}"`);
    const searchData = await webSearchVerify(claim.claim_text);
    webSearchCount++;

    if (searchData) {
      claim.web_search_result = searchData.web_search_result;
      claim.evidence_urls = searchData.evidence_urls || [];
      claim.evidence_domains = searchData.evidence_domains || [];
      const updatedResult = scoreClaim(claim, sourceData);

      log(`  web result: ${searchData.web_search_result} → confidence ${updatedResult.confidence.toFixed(3)} → ${updatedResult.suggested_status}`);

      Object.assign(result, updatedResult);

      if (updatedResult.suggested_status === 'supported' || updatedResult.suggested_status === 'refuted') {
        writeVerificationDraft(claim, updatedResult, searchData);
      }

      claim._searchData = searchData;
    }
  }

  // 5. Persist results
  if (!isDryRun) {
    vdb.runTransaction(() => {
      for (const row of results) {
        persistResult(row);
      }
    });

    log(`scored ${results.length} claims, web-searched ${webSearchCount}`);

    // 6. Process expiry
    processExpiry();

    // 7. Deep investigation on high-priority contested/unverified claims (max 2/day)
    await maybeInvestigate(results);

    // 8. Export for web
    exportVerificationData(vdb, config.VERIFICATION_EXPORT_PATH);
    syncToGCS();
  } else {
    log(`[dry-run] would persist ${results.length} results`);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────
run().catch(err => {
  log(`fatal: ${err.message}`);
  process.exit(0);  // non-fatal — don't block pipeline
});
