/**
 * apply_claim_tracker_delta.js
 * Reads state/claim_tracker_delta.json written by the agent, merges it into
 * state/claim_tracker.json, then removes the delta file.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { loadScraperDb, loadVerificationDb } = require('./lib/db_backend');
const { scoreClaim } = require('./intelligence/claim_scorer');
const db = loadScraperDb();
const vdb = loadVerificationDb();
const { canonicalDomain, normalizeUrl } = require('./lib/url_utils');

const ROOT        = path.resolve(__dirname, '..');
const TRACKER     = path.join(ROOT, 'state', 'claim_tracker.json');
const DELTA       = path.join(ROOT, 'state', 'claim_tracker_delta.json');

function log(...args) { console.log('[claim_tracker]', ...args); }

function readTracker() {
  try { return JSON.parse(fs.readFileSync(TRACKER, 'utf-8')); }
  catch { return { claims: [], updated_at: null }; }
}

function writeTracker(data) {
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(TRACKER, JSON.stringify(data, null, 2), 'utf-8');
}

function nextId(claims) {
  const nums = claims.map(c => parseInt((c.id || '').replace('claim_', ''), 10)).filter(n => !isNaN(n));
  return 'claim_' + ((nums.length ? Math.max(...nums) : 0) + 1);
}

function tweetIdFromUrl(url) {
  const match = String(url || '').match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function handleFromUrl(url) {
  const match = String(url || '').match(/x\.com\/([^/?#]+)/i);
  return match ? match[1].replace(/^@/, '').toLowerCase() : null;
}

function domainFor(rawUrl, allowX = false) {
  const normalized = normalizeUrl(rawUrl, { allowX });
  if (normalized) return normalized.domain;
  try {
    return canonicalDomain(new URL(rawUrl).hostname);
  } catch {
    return null;
  }
}

async function inferClaimAttribution(claim) {
  const sourcePostUrl = claim.source_post_url || claim.source_url || null;
  let citedUrl = claim.cited_url || null;

  if (!citedUrl) {
    const tweetId = tweetIdFromUrl(sourcePostUrl);
    if (tweetId) {
      const post = await db.getPostById(tweetId);
      if (post && Array.isArray(post.external_urls) && post.external_urls.length > 0) {
        citedUrl = post.external_urls[0];
      }
    }
  }

  return {
    source_post_url: sourcePostUrl,
    source_domain: domainFor(sourcePostUrl, true),
    cited_url: citedUrl,
    cited_domain: domainFor(citedUrl, false),
  };
}

function buildVerificationSeed(claim) {
  const seededClaim = {
    source_tier: claim.source_tier || null,
    corroborating_count: claim.corroborating_count || 0,
    contradicting_count: claim.contradicting_count || 0,
    cited_url: claim.cited_url || null,
    cited_domain: claim.cited_domain || null,
    web_search_result: null,
  };
  const { confidence, breakdown } = scoreClaim(seededClaim, {});
  return {
    claim_id: claim.id,
    claim_source: 'tracker',
    claim_text: claim.claim_text,
    confidence_score: confidence,
    scoring_breakdown: breakdown,
    status: claim.status || 'unverified',
    source_handle: handleFromUrl(claim.source_post_url || claim.source_url),
    source_tier: claim.source_tier || null,
    related_axis_id: claim.related_axis_id || null,
    category: claim.category || null,
    created_at: claim.created_at || new Date().toISOString(),
  };
}

async function syncClaimToVerificationDb(claim) {
  if (!claim?.id || !claim.claim_text) return false;

  const seed = buildVerificationSeed(claim);
  let existing = null;
  try {
    existing = await Promise.resolve(vdb.getVerification(seed.claim_id));
  } catch (err) {
    log('verification lookup failed for', seed.claim_id + ':', err.message);
  }

  const unchanged = existing &&
    existing.claim_text === seed.claim_text &&
    existing.status === seed.status &&
    (existing.source_handle || null) === (seed.source_handle || null) &&
    (existing.related_axis_id || null) === (seed.related_axis_id || null) &&
    (existing.category || null) === (seed.category || null) &&
    Math.abs((existing.confidence_score || 0) - seed.confidence_score) < 1e-9;

  if (unchanged) return false;

  try {
    await Promise.resolve(vdb.upsertVerification(seed));
    return true;
  } catch (err) {
    log('verification sync failed for', seed.claim_id + ':', err.message);
    return false;
  }
}

(async () => {
  if (!fs.existsSync(DELTA)) { log('no delta -- nothing to do'); process.exit(0); }

  let delta;
  try { delta = JSON.parse(fs.readFileSync(DELTA, 'utf-8')); }
  catch (e) { log('invalid delta JSON:', e.message); process.exit(0); }

  const tracker = readTracker();
  let added = 0, updated = 0;
  let synced = 0;

  for (const claim of (delta.new_claims || [])) {
    const id = nextId(tracker.claims);
    const attribution = await inferClaimAttribution(claim);
    tracker.claims.push({
      id,
      claim_text: claim.claim_text,
      source_url: claim.source_url || attribution.source_post_url || null,
      source_post_url: attribution.source_post_url,
      source_domain: attribution.source_domain,
      cited_url: attribution.cited_url,
      cited_domain: attribution.cited_domain,
      related_axis_id: claim.related_axis_id || null,
      status: 'unverified',
      notes: claim.notes || null,
      created_at: new Date().toISOString(),
      updated_at: null,
    });
    added++;
    if (await syncClaimToVerificationDb(tracker.claims[tracker.claims.length - 1])) synced++;
    log('added: ' + id + ' -- ' + claim.claim_text.slice(0, 60));
  }

  for (const update of (delta.updated_claims || [])) {
    const existing = tracker.claims.find(c => c.id === update.id);
    if (!existing) { log('unknown claim id: ' + update.id + ' -- skipping'); continue; }
    const attribution = await inferClaimAttribution({
      source_post_url: update.source_post_url || existing.source_post_url || existing.source_url,
      source_url: update.source_url || existing.source_url,
      cited_url: update.cited_url || existing.cited_url,
    });
    existing.status = update.new_status || existing.status;
    existing.notes  = update.notes ? (existing.notes ? existing.notes + ' | ' + update.notes : update.notes) : existing.notes;
    existing.source_url = update.source_url || existing.source_url || attribution.source_post_url || null;
    existing.source_post_url = attribution.source_post_url || existing.source_post_url || null;
    existing.source_domain = attribution.source_domain || existing.source_domain || null;
    existing.cited_url = attribution.cited_url || existing.cited_url || null;
    existing.cited_domain = attribution.cited_domain || existing.cited_domain || null;
    existing.updated_at = new Date().toISOString();
    updated++;
    if (await syncClaimToVerificationDb(existing)) synced++;
    log('updated: ' + update.id + ' -> ' + existing.status);
  }

  writeTracker(tracker);
  fs.unlinkSync(DELTA);
  log('done. added=' + added + ' updated=' + updated + ' synced=' + synced + ' total=' + tracker.claims.length);
})().catch(err => {
  log('fatal:', err.message);
  process.exit(0);
});
