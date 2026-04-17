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
 * Uses BUILDER_CREDENTIALS (separate SA) to avoid rate-limit contention
 * with the browse/synthesize pipeline.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const config = require('../lib/config');
const { loadVerificationDb } = require('../lib/db_backend');
const { scoreClaim }         = require('./claim_scorer');

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

// ── Web search (uses BUILDER_CREDENTIALS) ───────────────────────────────────

async function webSearchVerify(claimText) {
  const { getTokenForKey, getProjectConfig } = require('../gcp_auth');
  const builderKey = process.env.BUILDER_CREDENTIALS;
  if (!builderKey) throw new Error('BUILDER_CREDENTIALS not set');

  const token = await getTokenForKey(builderKey);
  const { project, location } = getProjectConfig();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`;

  const prompt = [
    'You are a fact-checker and claim analyst. Evaluate the following claim using current information.',
    '',
    `CLAIM: "${claimText}"`,
    '',
    'Search for evidence about this claim. Then respond with ONLY valid JSON (no markdown, no code fences):',
    '{',
    '  "verdict": "confirmed" | "refuted" | "partial" | "inconclusive" | "no_results",',
    '  "summary": "2-3 sentence explanation of findings",',
    '  "evidence_urls": ["url1", "url2"],',
    '  "original_source": "who first made or reported this claim",',
    '  "claim_date": "YYYY-MM-DD or YYYY-MM",',
    '  "supporting_sources": [{"name": "source", "stance": "brief position"}],',
    '  "dissenting_sources": [{"name": "source", "stance": "brief counter-position"}],',
    '  "framing_analysis": "Is this framed as a valid question or a misleading premise? 1-2 sentences."',
    '}',
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      log(`web search HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');

    const grounding = data?.candidates?.[0]?.groundingMetadata;
    const groundingUrls = (grounding?.groundingChunks || [])
      .filter(c => c.web?.uri).map(c => c.web.uri);

    let parsed;
    try {
      let clean = text.replace(/```json\s*\n?/gi, '').replace(/```\s*/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) clean = jsonMatch[0];
      parsed = JSON.parse(clean);
    } catch {
      log(`failed to parse response: ${text.slice(0, 200)}`);
      // Salvage summary from malformed JSON
      const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const verdictMatch = text.match(/"verdict"\s*:\s*"(\w+)"/);
      return {
        web_search_result: verdictMatch ? (verdictMatch[1] === 'refuted' ? 'refuted' : verdictMatch[1] === 'confirmed' ? 'confirmed' : verdictMatch[1] === 'partial' ? 'partial' : 'inconclusive') : 'inconclusive',
        summary: summaryMatch ? summaryMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : text.replace(/```json\s*/gi, '').replace(/```/g, '').trim().slice(0, 500),
        evidence_urls: groundingUrls,
      };
    }

    const verdictMap = { confirmed: 'confirmed', refuted: 'refuted', partial: 'partial', inconclusive: 'inconclusive', no_results: 'no_results' };
    return {
      web_search_result:  verdictMap[parsed.verdict] || 'inconclusive',
      summary:            parsed.summary || '',
      evidence_urls:      [...new Set([...(parsed.evidence_urls || []), ...groundingUrls])].slice(0, 5),
      original_source:    parsed.original_source || null,
      claim_date:         parsed.claim_date || null,
      supporting_sources: parsed.supporting_sources || [],
      dissenting_sources: parsed.dissenting_sources || [],
      framing_analysis:   parsed.framing_analysis || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Load source data ────────────────────────────────────────────────────────

function loadSourceData(handle) {
  if (!handle) return {};
  try {
    const registry = JSON.parse(fs.readFileSync(
      path.join(config.STATE_DIR, 'source_registry.json'), 'utf-8'
    ));
    const acct = registry.accounts?.[handle.replace(/^@/, '')];
    if (acct) return { credibility_tier: acct.credibility_tier, ng_score: acct.ng_score };
  } catch {}
  return {};
}

// ── Export for web (reuse from verify_claims logic) ─────────────────────────

function exportVerificationData() {
  try {
    const all = vdb.getAllVerifications();
    const stats = { total: all.length, supported: 0, refuted: 0, contested: 0, unverified: 0, expired: 0 };
    for (const c of all) { stats[c.status] = (stats[c.status] || 0) + 1; }

    const exportData = {
      generated_at: new Date().toISOString(),
      stats,
      claims: all.map(c => ({
        claim_id:           c.claim_id,
        claim_text:         c.claim_text,
        status:             c.status,
        confidence_score:   c.confidence_score,
        scoring_breakdown:  c.scoring_breakdown,
        source_handle:      c.source_handle,
        source_tier:        c.source_tier,
        evidence_urls:      (c.evidence_urls || []).filter(u => !String(u).includes('vertexaisearch.cloud.google.com')),
        tweet_url:          c.tweet_url,
        category:           c.category,
        related_axis_id:    c.related_axis_id,
        verification_count: c.verification_count,
        verified_at:        c.last_verified_at,
        created_at:         c.created_at,
        original_source:    c.original_source || null,
        claim_date:         c.claim_date || null,
        supporting_sources: c.supporting_sources || [],
        dissenting_sources: c.dissenting_sources || [],
        framing_analysis:   c.framing_analysis || null,
        web_search_summary: c.web_search_summary || null,
      })),
    };

    fs.writeFileSync(config.VERIFICATION_EXPORT_PATH, JSON.stringify(exportData, null, 2), 'utf-8');
    log(`export updated: ${stats.total} claims`);
  } catch (err) {
    log(`export error: ${err.message}`);
  }
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
  const sourceData = loadSourceData(handle);

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
      const result = {
        claim_id:     claimId,
        status:       existing.status,
        confidence:   existing.confidence_score,
        summary:      existing.web_search_summary,
        verdict_label: verdictLabel,
        lens_url:     `https://sebastianhunter.fun/veritas-lens#${claimId}`,
        cached:       true,
      };
      console.log(JSON.stringify(result));
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
    category:            opts.category || null,
    related_axis_id:     opts.axis || null,
  };

  const result = scoreClaim(claimObj, sourceData);
  log(`score: ${result.confidence.toFixed(3)} → ${result.suggested_status}`);

  // 4. Persist
  if (!opts.dryRun) {
    const stableUrls = (searchData?.evidence_urls || [])
      .filter(u => !String(u).includes('vertexaisearch.cloud.google.com'));

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
    exportVerificationData();
  }

  // 6. Output for caller
  const verdictLabel = result.suggested_status === 'supported' ? 'Supported'
    : result.suggested_status === 'refuted' ? 'Refuted'
    : result.suggested_status === 'contested' ? 'Contested'
    : 'Unverified';

  const output = {
    claim_id:      claimId,
    status:        result.suggested_status,
    confidence:    result.confidence,
    summary:       searchData?.summary || null,
    verdict_label: verdictLabel,
    lens_url:      `https://sebastianhunter.fun/veritas-lens#${claimId}`,
    evidence_urls: (searchData?.evidence_urls || []).filter(u => !String(u).includes('vertexaisearch')).slice(0, 3),
    framing:       searchData?.framing_analysis || null,
    cached:        false,
  };

  console.log(JSON.stringify(output));
}

run().catch(err => {
  console.error(`[verify_one] fatal: ${err.message}`);
  process.exit(1);
});
