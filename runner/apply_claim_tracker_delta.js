/**
 * apply_claim_tracker_delta.js
 * Reads state/claim_tracker_delta.json written by the agent, merges it into
 * state/claim_tracker.json, then removes the delta file.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const db   = require('../scraper/db');
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

function domainFor(rawUrl, allowX = false) {
  const normalized = normalizeUrl(rawUrl, { allowX });
  if (normalized) return normalized.domain;
  try {
    return canonicalDomain(new URL(rawUrl).hostname);
  } catch {
    return null;
  }
}

function inferClaimAttribution(claim) {
  const sourcePostUrl = claim.source_post_url || claim.source_url || null;
  let citedUrl = claim.cited_url || null;

  if (!citedUrl) {
    const tweetId = tweetIdFromUrl(sourcePostUrl);
    if (tweetId) {
      const post = db.getPostById(tweetId);
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

if (!fs.existsSync(DELTA)) { log('no delta -- nothing to do'); process.exit(0); }

let delta;
try { delta = JSON.parse(fs.readFileSync(DELTA, 'utf-8')); }
catch (e) { log('invalid delta JSON:', e.message); process.exit(0); }

const tracker = readTracker();
let added = 0, updated = 0;

for (const claim of (delta.new_claims || [])) {
  const id = nextId(tracker.claims);
  const attribution = inferClaimAttribution(claim);
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
  log('added: ' + id + ' -- ' + claim.claim_text.slice(0, 60));
}

for (const update of (delta.updated_claims || [])) {
  const existing = tracker.claims.find(c => c.id === update.id);
  if (!existing) { log('unknown claim id: ' + update.id + ' -- skipping'); continue; }
  const attribution = inferClaimAttribution({
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
  log('updated: ' + update.id + ' -> ' + existing.status);
}

writeTracker(tracker);
fs.unlinkSync(DELTA);
log('done. added=' + added + ' updated=' + updated + ' total=' + tracker.claims.length);
