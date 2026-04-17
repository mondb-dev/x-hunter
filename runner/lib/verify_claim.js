/**
 * runner/lib/verify_claim.js — wrapper for on-demand claim verification
 *
 * Calls runner/intelligence/verify_one.js via execFileSync, parses the JSON result,
 * and returns it. Handles stdout noise from web_search debug output by scanning
 * lines bottom-up for the first JSON object.
 *
 * Used by:
 *   - runner/post_claims_thread.js (claims cycle thread)
 *   - runner/proactive_reply.js (high-engagement post reply)
 *   - scraper/reply.js (inbound mention verification)
 *
 * Exports:
 *   verifyClaim(opts) → { claim_id, status, confidence, summary, verdict_label, lens_url, evidence_urls, framing, cached } | null
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function log(msg) { console.log(`[verify_claim] ${msg}`); }

/**
 * Verify a claim on-demand.
 *
 * @param {object} opts
 * @param {string} opts.claim - claim text to verify (required)
 * @param {string} [opts.handle] - source handle (e.g. '@CNN')
 * @param {string} [opts.url] - source URL
 * @param {string} [opts.category] - claim category (military_action, diplomatic, etc.)
 * @param {string} [opts.axis] - related ontology axis ID
 * @param {number} [opts.tier] - source credibility tier 1-5
 * @param {boolean} [opts.dryRun] - score without persisting
 *
 * @returns {object|null} { claim_id, status, confidence, summary, verdict_label, lens_url, evidence_urls, framing, cached }
 *         or null on error (never throws)
 */
function verifyClaim(opts) {
  if (!opts || !opts.claim) {
    log('missing required claim parameter');
    return null;
  }

  try {
    const args = [
      'runner/intelligence/verify_one.js',
      '--claim', opts.claim,
    ];

    if (opts.handle) args.push('--source-handle', opts.handle);
    if (opts.url) args.push('--source-url', opts.url);
    if (opts.category) args.push('--category', opts.category);
    if (opts.axis) args.push('--axis', opts.axis);
    if (opts.tier) args.push('--source-tier', String(opts.tier));
    if (opts.dryRun) args.push('--dry-run');

    const stdout = execFileSync('node', args, {
      cwd: ROOT,
      timeout: 90_000,
      encoding: 'utf-8',
    });

    // Scan lines bottom-up for the first valid JSON object
    // (web_search may emit debug lines with incomplete JSON)
    const lines = stdout.trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.claim_id && json.status !== undefined) {
          return json;
        }
      } catch {
        // Not JSON, try next line
      }
    }

    log(`no valid JSON found in output: ${stdout.slice(0, 200)}`);
    return null;
  } catch (err) {
    log(`error: ${err.message}`);
    return null;
  }
}

/**
 * Deep investigate a claim (full agent loop, ~5-10 minutes).
 *
 * @param {object} opts
 * @param {string} opts.claim - claim text (required)
 * @param {string} [opts.claimId] - existing claim ID
 * @param {string} [opts.handle] - source handle
 * @param {string} [opts.url] - source URL
 * @param {string} [opts.category]
 * @param {string} [opts.axis]
 * @param {number} [opts.tier]
 * @param {boolean} [opts.dryRun]
 *
 * @returns {object|null} { claim_id, investigation_id, status, confidence, summary, key_finding, ... }
 */
function investigateClaimSync(opts) {
  if (!opts || !opts.claim) {
    log('investigateClaimSync: missing required claim parameter');
    return null;
  }

  try {
    const args = [
      'runner/intelligence/investigate_claim.js',
      '--claim', opts.claim,
    ];

    if (opts.claimId) args.push('--claim-id', opts.claimId);
    if (opts.handle) args.push('--source-handle', opts.handle);
    if (opts.url) args.push('--source-url', opts.url);
    if (opts.category) args.push('--category', opts.category);
    if (opts.axis) args.push('--axis', opts.axis);
    if (opts.tier) args.push('--source-tier', String(opts.tier));
    if (opts.dryRun) args.push('--dry-run');

    const stdout = execFileSync('node', args, {
      cwd: ROOT,
      timeout: 900_000, // 15 min
      encoding: 'utf-8',
    });

    const lines = stdout.trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.claim_id && json.investigation_id) return json;
      } catch {}
    }

    log(`investigateClaimSync: no valid JSON in output`);
    return null;
  } catch (err) {
    log(`investigateClaimSync error: ${err.message}`);
    return null;
  }
}

module.exports = { verifyClaim, investigateClaimSync };
