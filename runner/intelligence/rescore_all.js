#!/usr/bin/env node
/**
 * One-off script: re-run web search on all verified claims to populate
 * structured supporting/dissenting sources with URLs + excerpts.
 *
 * Usage:
 *   node runner/intelligence/rescore_all.js              # run
 *   node runner/intelligence/rescore_all.js --dry-run    # preview only
 *
 * Rate limiting: 2s delay between web searches to respect Gemini limits.
 */

'use strict';

const fs = require('fs');
const config = require('../lib/config');
const { loadIntelligenceDb, loadVerificationDb, usePostgres } = require('../lib/db_backend');
const { scoreClaim } = require('./claim_scorer');
const { webSearchVerify } = require('./lib/web_search');
const { exportVerificationData, filterStableUrls } = require('./lib/verification_export');
const { loadSourceData } = require('./lib/source_data');

const idb = loadIntelligenceDb();
const vdb = loadVerificationDb();
const DB_IS_PG = usePostgres();
const isDryRun = process.argv.includes('--dry-run');

function log(msg) { console.log(`[rescore_all] ${msg}`); }

const DELAY_MS = 2000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function handleFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/x\.com\/([^/]+)/);
  return match ? match[1].toLowerCase() : null;
}

async function run() {
  const all = vdb.getAllVerifications();
  log(`${all.length} claims to re-verify`);

  let searched = 0;
  let updated = 0;
  let errors = 0;

  for (const claim of all) {
    if (claim.status === 'expired') continue;

    log(`[${searched + 1}/${all.length}] "${(claim.claim_text || '').slice(0, 70)}"`);

    try {
      const searchData = await webSearchVerify(claim.claim_text);
      searched++;

      if (!searchData) {
        log('  -> no search result');
        errors++;
        await sleep(DELAY_MS);
        continue;
      }

      const handle = claim.source_handle || handleFromUrl(claim.source_url);
      const sourceData = await loadSourceData(handle, idb, config.STATE_DIR, DB_IS_PG);

      // Build enriched claim obj for scorer
      const claimObj = {
        ...claim,
        web_search_result: searchData.web_search_result,
        evidence_urls: searchData.evidence_urls || [],
        evidence_domains: searchData.evidence_domains || [],
      };

      const result = scoreClaim(claimObj, sourceData);

      log(`  -> ${searchData.web_search_result} | confidence ${result.confidence.toFixed(3)} -> ${result.suggested_status} | ${(searchData.supporting_sources||[]).length} supporting, ${(searchData.dissenting_sources||[]).length} dissenting`);

      if (!isDryRun) {
        vdb.upsertVerification({
          claim_id: claim.claim_id,
          claim_source: claim.claim_source || 'intelligence',
          claim_text: claim.claim_text,
          confidence_score: result.confidence,
          scoring_breakdown: result.breakdown,
          status: result.suggested_status,
          web_search_summary: searchData.summary || null,
          evidence_urls: filterStableUrls(searchData.evidence_urls).length
            ? filterStableUrls(searchData.evidence_urls) : null,
          source_handle: handle || claim.source_handle || null,
          source_tier: claim.source_tier || null,
          related_axis_id: claim.related_axis_id || null,
          category: claim.category || null,
          original_source: searchData.original_source || null,
          claim_date: searchData.claim_date || null,
          supporting_sources: searchData.supporting_sources || null,
          dissenting_sources: searchData.dissenting_sources || null,
          framing_analysis: searchData.framing_analysis || null,
          created_at: claim.created_at,
        });
        updated++;
      }
    } catch (err) {
      log(`  -> error: ${err.message}`);
      errors++;
    }

    await sleep(DELAY_MS);
  }

  if (!isDryRun) {
    exportVerificationData(vdb, config.VERIFICATION_EXPORT_PATH);
    log(`done: ${searched} searched, ${updated} updated, ${errors} errors`);
  } else {
    log(`[dry-run] would update ${searched} claims`);
  }
}

run().catch(err => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
