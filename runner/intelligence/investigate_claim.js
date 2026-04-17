#!/usr/bin/env node
/**
 * runner/intelligence/investigate_claim.js — deep claim investigation
 *
 * Uses the Gemini agent loop (navigate, web_search, etc.) to decompose a claim
 * into sub-questions, follow attribution chains, cross-reference sources, and
 * produce a structured evidence report.
 *
 * Usage:
 *   node runner/intelligence/investigate_claim.js --claim "The claim text"
 *   node runner/intelligence/investigate_claim.js --claim "..." --source-handle @user
 *   node runner/intelligence/investigate_claim.js --claim "..." --claim-id live_abc123
 *   node runner/intelligence/investigate_claim.js --claim "..." --dry-run
 *
 * Exits 0 with JSON on stdout. Uses BUILDER_CREDENTIALS for LLM calls.
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const config = require('../lib/config');
const { loadVerificationDb }  = require('../lib/db_backend');
const { scoreClaim }          = require('./claim_scorer');
const { exportVerificationData, filterStableUrls } = require('./lib/verification_export');
const { loadSourceData }      = require('./lib/source_data');
const buildInvestigatePrompt  = require('../lib/prompts/investigate');

const RESULT_FILE = path.join(config.STATE_DIR, 'investigation_result.json');
const SCRATCH_FILE = path.join(config.STATE_DIR, 'investigation_scratch.json');

function log(msg) { console.error(`[investigate] ${msg}`); }

// ── Parse args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--claim'         && args[i+1]) { opts.claim        = args[++i]; continue; }
    if (args[i] === '--claim-id'      && args[i+1]) { opts.claimId      = args[++i]; continue; }
    if (args[i] === '--source-handle' && args[i+1]) { opts.sourceHandle = args[++i]; continue; }
    if (args[i] === '--source-url'    && args[i+1]) { opts.sourceUrl    = args[++i]; continue; }
    if (args[i] === '--category'      && args[i+1]) { opts.category     = args[++i]; continue; }
    if (args[i] === '--axis'          && args[i+1]) { opts.axis         = args[++i]; continue; }
    if (args[i] === '--source-tier'   && args[i+1]) { opts.sourceTier   = parseInt(args[++i], 10); continue; }
    if (args[i] === '--max-turns'     && args[i+1]) { opts.maxTurns     = parseInt(args[++i], 10); continue; }
    if (args[i] === '--dry-run')                     { opts.dryRun       = true; continue; }
  }
  return opts;
}

function makeClaimId(text) {
  const hash = crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 10);
  return `live_${hash}`;
}

function makeInvestigationId(claimId) {
  const ts = Date.now().toString(36);
  return `inv_${claimId.replace('live_', '')}_${ts}`;
}

// ── Read agent output ───────────────────────────────────────────────────────

function readAgentResult() {
  try {
    const raw = fs.readFileSync(RESULT_FILE, 'utf-8');
    // Strip markdown fences if present
    const clean = raw.replace(/```json\s*\n?/gi, '').replace(/```\s*/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return JSON.parse(clean);
  } catch (err) {
    log(`failed to parse investigation_result.json: ${err.message}`);
    return null;
  }
}

// ── Extract evidence domains from investigation results ─────────────────────

function extractEvidenceData(result) {
  const urls = [];
  const domains = [];

  const collectSources = (arr) => {
    for (const s of (arr || [])) {
      if (s.url) urls.push(s.url);
      if (s.domain) domains.push(s.domain);
      else if (s.url) {
        try { domains.push(new URL(s.url).hostname.replace(/^www\./, '')); } catch {}
      }
    }
  };

  // Collect from sub-question sources
  for (const sq of (result.sub_questions || [])) {
    collectSources(sq.sources);
  }
  collectSources(result.supporting_evidence);
  collectSources(result.contradicting_evidence);

  // Collect from attribution chain
  for (const a of (result.attribution_chain || [])) {
    if (a.url) urls.push(a.url);
  }

  return {
    evidence_urls: [...new Set(urls)],
    evidence_domains: [...new Set(domains)],
    supporting_count: (result.supporting_evidence || []).length,
    contradicting_count: (result.contradicting_evidence || []).length,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs();
  if (!opts.claim) {
    console.error('Usage: investigate_claim.js --claim "text" [--source-handle @user] [--claim-id id] [--dry-run]');
    process.exit(1);
  }

  const claimText = opts.claim.trim();
  const claimId   = opts.claimId || makeClaimId(claimText);
  const handle    = opts.sourceHandle?.replace(/^@/, '') || null;
  const invId     = makeInvestigationId(claimId);

  const vdb = loadVerificationDb();

  log(`investigating: "${claimText.slice(0, 80)}..." (claim=${claimId}, inv=${invId})`);

  // Check for prior verification to seed the investigation
  const existing = vdb.getVerification(claimId);
  const priorSummary = existing?.web_search_summary || null;

  // Clean up any previous result file
  try { fs.unlinkSync(RESULT_FILE); } catch {}
  try { fs.unlinkSync(SCRATCH_FILE); } catch {}

  // Build the investigation prompt
  const prompt = buildInvestigatePrompt({
    claimText,
    handle: handle ? `@${handle}` : null,
    sourceUrl: opts.sourceUrl,
    priorSummary,
    category: opts.category,
  });

  // Run the agent with BUILDER_CREDENTIALS
  const startTs = Date.now();
  const { agentRunSync } = require('../lib/gemini_agent');

  // Override credentials to use builder SA (avoids rate-limit contention)
  const builderKey = process.env.BUILDER_CREDENTIALS
    || path.join(process.env.HOME || '/root', 'builder-sa-key.json');
  if (fs.existsSync(builderKey)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = builderKey;
    log(`using builder SA: ${path.basename(builderKey)}`);
  }

  const exitCode = agentRunSync({
    agent: 'x-hunter-investigate',
    message: prompt,
    thinking: 'high',
    verbose: 'on',
  });

  const durationSec = Math.floor((Date.now() - startTs) / 1000);
  log(`agent finished in ${durationSec}s with exit=${exitCode}`);

  // Read agent output
  const result = readAgentResult();
  if (!result) {
    log('no valid investigation result found');
    console.log(JSON.stringify({
      claim_id: claimId,
      investigation_id: invId,
      status: 'failed',
      error: 'Agent did not produce investigation_result.json',
    }));
    process.exit(1);
  }

  log(`verdict: ${result.overall_verdict}, confidence: ${result.confidence}`);
  log(`sub-questions: ${(result.sub_questions || []).length}, ` +
      `supporting: ${(result.supporting_evidence || []).length}, ` +
      `contradicting: ${(result.contradicting_evidence || []).length}`);

  // Score using enriched data from investigation
  const evidenceData = extractEvidenceData(result);
  const sourceData = await loadSourceData(handle, null, config.STATE_DIR);

  const verdictMap = {
    confirmed: 'confirmed', refuted: 'refuted',
    partial: 'partial', inconclusive: 'inconclusive',
  };

  const claimObj = {
    claim_id:            claimId,
    claim_text:          claimText,
    source_handle:       handle,
    source_tier:         opts.sourceTier || null,
    corroborating_count: evidenceData.supporting_count,
    contradicting_count: evidenceData.contradicting_count,
    cited_url:           opts.sourceUrl || null,
    cited_domain:        null,
    web_search_result:   verdictMap[result.overall_verdict] || 'inconclusive',
    evidence_urls:       evidenceData.evidence_urls,
    evidence_domains:    evidenceData.evidence_domains,
  };

  const scoreResult = scoreClaim(claimObj, sourceData);
  log(`score: ${scoreResult.confidence.toFixed(3)} -> ${scoreResult.suggested_status}`);

  // Persist if not dry-run
  if (!opts.dryRun) {
    // Save investigation
    vdb.insertInvestigation({
      investigation_id: invId,
      claim_id:         claimId,
      claim_text:       claimText,
      sub_questions:    result.sub_questions || [],
      attribution_chain: result.attribution_chain || [],
      supporting_evidence: result.supporting_evidence || [],
      contradicting_evidence: result.contradicting_evidence || [],
      overall_verdict:  result.overall_verdict,
      confidence:       result.confidence,
      summary:          result.summary,
      key_finding:      result.key_finding,
      raw_result:       result,
      turns_used:       0, // TODO: pass turns from agent
      duration_seconds: durationSec,
    });

    // Build source summary from investigation evidence
    const supportingSources = (result.supporting_evidence || []).map(e => ({
      name: `${e.domain || 'Unknown'}: ${(e.quote || e.relevance || '').slice(0, 120)}`,
      stance: 'supporting',
    }));
    const dissentingSources = (result.contradicting_evidence || []).map(e => ({
      name: `${e.domain || 'Unknown'}: ${(e.quote || e.relevance || '').slice(0, 120)}`,
      stance: 'contradicting',
    }));

    // Upsert the claim verification with deep investigation data
    vdb.upsertVerification({
      claim_id:           claimId,
      claim_source:       existing?.claim_source || 'live',
      claim_text:         claimText,
      confidence_score:   scoreResult.confidence,
      scoring_breakdown:  scoreResult.breakdown,
      status:             scoreResult.suggested_status,
      web_search_summary: result.summary || existing?.web_search_summary,
      evidence_urls:      filterStableUrls(evidenceData.evidence_urls),
      source_handle:      handle,
      source_tier:        opts.sourceTier || null,
      related_axis_id:    opts.axis || null,
      category:           opts.category || null,
      original_source:    existing?.original_source || null,
      claim_date:         existing?.claim_date || null,
      supporting_sources: supportingSources.length ? supportingSources : null,
      dissenting_sources: dissentingSources.length ? dissentingSources : null,
      framing_analysis:   result.key_finding || existing?.framing_analysis || null,
      created_at:         existing?.created_at || new Date().toISOString(),
    });

    // Link investigation to claim
    vdb.linkInvestigation(claimId, invId);

    // Audit log
    vdb.logAudit({
      claim_id:            claimId,
      claim_source:        existing?.claim_source || 'live',
      old_status:          existing?.status || null,
      new_status:          scoreResult.suggested_status,
      confidence_score:    scoreResult.confidence,
      scoring_breakdown:   scoreResult.breakdown,
      verification_method: 'deep_investigation',
      evidence_urls:       evidenceData.evidence_urls,
      notes:               `Deep investigation ${invId}: ${result.summary?.slice(0, 200) || ''}`,
    });

    // Re-export for web
    exportVerificationData(vdb, config.VERIFICATION_EXPORT_PATH);
    log('persisted and exported');
  }

  // Output for caller
  const verdictLabel = scoreResult.suggested_status === 'supported' ? 'Supported'
    : scoreResult.suggested_status === 'refuted' ? 'Refuted'
    : scoreResult.suggested_status === 'contested' ? 'Contested'
    : 'Unverified';

  console.log(JSON.stringify({
    claim_id:          claimId,
    investigation_id:  invId,
    status:            scoreResult.suggested_status,
    confidence:        scoreResult.confidence,
    verdict_label:     verdictLabel,
    summary:           result.summary,
    key_finding:       result.key_finding,
    sub_questions:     (result.sub_questions || []).length,
    supporting:        evidenceData.supporting_count,
    contradicting:     evidenceData.contradicting_count,
    attribution_depth: (result.attribution_chain || []).length,
    duration_seconds:  durationSec,
    lens_url:          `https://sebastianhunter.fun/veritas-lens#${claimId}`,
    cached:            false,
  }));
}

run().catch(err => {
  console.error(`[investigate] fatal: ${err.message}`);
  process.exit(1);
});
