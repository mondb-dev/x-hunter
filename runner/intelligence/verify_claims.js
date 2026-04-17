#!/usr/bin/env node
/**
 * runner/intelligence/verify_claims.js — claim verification pipeline
 *
 * Runs every browse cycle (called from post_browse.js step 4d).
 * Scores all unverified/contested claims, runs a web search on the top
 * priority claim, updates statuses, writes audit trail, and optionally
 * writes a verification_draft.txt for tweeting.
 *
 * Non-fatal: exits 0 on any error to avoid blocking the pipeline.
 *
 * Usage:
 *   node runner/intelligence/verify_claims.js              # normal
 *   node runner/intelligence/verify_claims.js --dry-run    # score + print, no writes
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('../lib/config');
const { loadIntelligenceDb, loadVerificationDb, usePostgres } = require('../lib/db_backend');

const { scoreClaim } = require('./claim_scorer');
const idb = loadIntelligenceDb();
const vdb = loadVerificationDb();
const DB_IS_PG = usePostgres();

const isDryRun = process.argv.includes('--dry-run');

function log(msg) { console.log(`[verify_claims] ${msg}`); }

// ── Configuration ───────────────────────────────────────────────────────────
const MAX_CLAIMS_PER_CYCLE   = 10;   // score up to N claims per run
const WEB_SEARCH_PER_CYCLE   = 3;    // run web search on top N claims
const STALE_HOURS            = 48;   // claims older than this get priority bump
const EXPIRY_RULES = {               // hours until auto-expire by category
  military_action:         72,
  casualties_humanitarian: 72,
  threats_claims:          72,
  nuclear:                 168,      // 7 days
  diplomatic:              168,
  proxy_regional:          168,
  internal_politics:       720,      // 30 days
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

/**
 * Load source data for enrichment — tries intelligence.db first, then source_registry.json.
 */
async function loadSourceData(handle) {
  if (!handle) return {};
  try {
    let row;
    if (DB_IS_PG) {
      const result = await idb.query(
        'SELECT credibility_tier, ng_score FROM sources WHERE handle = $1',
        [handle]
      );
      row = result.rows[0];
    } else {
      row = idb.prepare('SELECT credibility_tier, ng_score FROM sources WHERE handle = ?').get(handle);
    }
    if (row && row.credibility_tier) return row;
  } catch {}
  try {
    const registry = JSON.parse(fs.readFileSync(
      path.join(config.STATE_DIR, 'source_registry.json'), 'utf-8'
    ));
    const acct = registry.accounts?.[handle];
    if (acct) return { credibility_tier: acct.credibility_tier, ng_score: acct.ng_score };
  } catch {}
  return {};
}

async function getVerification(claimId) {
  return DB_IS_PG ? vdb.getVerification(claimId) : vdb.getVerification(claimId);
}

async function getAllVerifications() {
  return DB_IS_PG ? vdb.getAllVerifications() : vdb.getAllVerifications();
}

async function markExpired(claimId) {
  return DB_IS_PG ? vdb.markExpired(claimId) : vdb.markExpired(claimId);
}

/**
 * Extract source handle from X.com URL.
 */
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
    // Fresh claims (last 6h) get highest priority
    const age = now - new Date(c.created_at || 0).getTime();
    if (age < 6 * 3600_000) priority += 30;
    // High corroboration but unresolved → worth verifying
    priority += Math.min((c.corroborating_count || 0) * 5, 20);
    // Stale claims (>48h unverified) need attention
    if (age > STALE_HOURS * 3600_000) priority += 10;
    // Tracker claims (curated) take slight priority over extracted
    if (c.claim_source === 'tracker') priority += 5;
    // Claims with cited URLs are easier to verify
    if (c.cited_url) priority += 5;
    return { ...c, _priority: priority };
  }).sort((a, b) => b._priority - a._priority);
}

// ── Web search verification ─────────────────────────────────────────────────

/**
 * Use Vertex AI with Google Search grounding to verify a claim.
 * Returns { web_search_result, summary, evidence_urls }
 */
async function webSearchVerify(claimText) {
  try {
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
      '  "original_source": "who first made or reported this claim (person, outlet, or organization)",',
      '  "claim_date": "approximate date the claim was first made (YYYY-MM-DD or YYYY-MM)",',
      '  "supporting_sources": [{"name": "source name", "stance": "brief description of their position"}],',
      '  "dissenting_sources": [{"name": "source name", "stance": "brief description of their counter-position"}],',
      '  "framing_analysis": "Is the claim framed as a valid category/question, or is it a false dichotomy, misleading framing, or loaded question? Explain in 1-2 sentences."',
      '}',
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
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

      // Extract grounding URLs
      const grounding = data?.candidates?.[0]?.groundingMetadata;
      const groundingUrls = (grounding?.groundingChunks || [])
        .filter(c => c.web?.uri)
        .map(c => c.web.uri);

      // Parse structured response
      let parsed;
      try {
        // Strip markdown fences if present, extract JSON object
        let clean = text.replace(/```json\s*\n?/gi, '').replace(/```\s*/g, '').trim();
        // If there's still non-JSON surrounding text, extract the JSON object
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) clean = jsonMatch[0];
        parsed = JSON.parse(clean);
      } catch {
        log(`failed to parse web search response: ${text.slice(0, 200)}`);
        // Try to salvage a summary string even from malformed JSON
        const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const fallbackSummary = summaryMatch
          ? summaryMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"')
          : text.replace(/```json\s*/gi, '').replace(/```/g, '').replace(/\{[\s\S]*\}/, '').trim().slice(0, 500);
        return {
          web_search_result: 'inconclusive',
          summary: fallbackSummary || text.slice(0, 500),
          evidence_urls: groundingUrls,
        };
      }

      // Map verdict to numeric score
      const verdictMap = {
        confirmed:    'confirmed',
        refuted:      'refuted',
        partial:      'partial',
        inconclusive: 'inconclusive',
        no_results:   'no_results',
      };
      const verdict = verdictMap[parsed.verdict] || 'inconclusive';

      return {
        web_search_result: verdict,
        summary: parsed.summary || '',
        evidence_urls: [...new Set([...(parsed.evidence_urls || []), ...groundingUrls])].slice(0, 5),
        key_sources: parsed.key_sources || [],
        original_source: parsed.original_source || null,
        claim_date: parsed.claim_date || null,
        supporting_sources: parsed.supporting_sources || [],
        dissenting_sources: parsed.dissenting_sources || [],
        framing_analysis: parsed.framing_analysis || null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log(`web search error: ${err.message}`);
    return null;
  }
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

// ── Export verification data for web ────────────────────────────────────────

async function exportVerificationData() {
  try {
    const all = await getAllVerifications();
    const stats = { total: all.length, supported: 0, refuted: 0, contested: 0, unverified: 0, expired: 0 };
    for (const c of all) { stats[c.status] = (stats[c.status] || 0) + 1; }

    const exportData = {
      generated_at: new Date().toISOString(),
      stats,
      claims: all.map(c => ({
        claim_id: c.claim_id,
        claim_text: c.claim_text,
        status: c.status,
        confidence_score: c.confidence_score,
        scoring_breakdown: c.scoring_breakdown,
        source_handle: c.source_handle,
        source_tier: c.source_tier,
        evidence_urls: (c.evidence_urls || []).filter(u => !String(u).includes('vertexaisearch.cloud.google.com')),
        tweet_url: c.tweet_url,
        category: c.category,
        related_axis_id: c.related_axis_id,
        verification_count: c.verification_count,
        verified_at: c.last_verified_at,
        created_at: c.created_at,
        original_source: c.original_source || null,
        claim_date: c.claim_date || null,
        supporting_sources: c.supporting_sources || [],
        dissenting_sources: c.dissenting_sources || [],
        framing_analysis: c.framing_analysis || null,
        web_search_summary: c.web_search_summary || null,
      })),
    };

    fs.writeFileSync(config.VERIFICATION_EXPORT_PATH, JSON.stringify(exportData, null, 2), 'utf-8');
    log(`export written: ${stats.total} claims`);
  } catch (err) {
    log(`export error: ${err.message}`);
  }
}

// ── Claim lifecycle (expiry) ────────────────────────────────────────────────

async function processExpiry() {
  const now = Date.now();
  const all = await getAllVerifications();
  let expired = 0;

  for (const claim of all) {
    if (claim.status === 'expired' || claim.status === 'supported' || claim.status === 'refuted') continue;
    const expiryHours = EXPIRY_RULES[claim.category] || DEFAULT_EXPIRY_HOURS;
    const age = now - new Date(claim.created_at).getTime();
    if (age > expiryHours * 3600_000) {
      if (!isDryRun) {
        await markExpired(claim.claim_id);
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
    if (!isDryRun) await exportVerificationData();
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
    const sourceData = await loadSourceData(handle);

    // Check existing verification for web_search_result carry-forward
    const existing = await getVerification(claim.claim_id);
    if (existing?.web_search_summary && !claim.web_search_result) {
      // Preserve previous web search result
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

  // 4. Web search on top priority claim(s) that haven't been searched yet
  for (const { claim, result, sourceData, handle, oldStatus } of results) {
    if (webSearchCount >= WEB_SEARCH_PER_CYCLE) break;

    const existing = await getVerification(claim.claim_id);
    // Skip only if already web-searched AND result is recent (within 24h).
    // last_verified_at is updated on every scoring cycle so cannot be used alone.
    if (existing?.web_search_summary && existing?.last_verified_at) {
      const lastVerified = new Date(existing.last_verified_at).getTime();
      if (Date.now() - lastVerified < 24 * 3600_000) continue;
    }

    log(`web searching: "${(claim.claim_text || '').slice(0, 80)}"`);
    const searchData = await webSearchVerify(claim.claim_text);
    webSearchCount++;

    if (searchData) {
      // Re-score with web search result
      claim.web_search_result = searchData.web_search_result;
      const updatedResult = scoreClaim(claim, sourceData);

      log(`  web result: ${searchData.web_search_result} → confidence ${updatedResult.confidence.toFixed(3)} → ${updatedResult.suggested_status}`);

      // Update the result in our list
      Object.assign(result, updatedResult);

      // Write verification draft if claim resolved
      if (updatedResult.suggested_status === 'supported' || updatedResult.suggested_status === 'refuted') {
        writeVerificationDraft(claim, updatedResult, searchData);
      }

      // Store search data for DB write
      claim._searchData = searchData;
    }
  }

  // 5. Persist results
  if (!isDryRun) {
    const persistOne = async ({ claim, result, handle, oldStatus }) => {
      const searchData = claim._searchData;
      const statusChanged = result.suggested_status !== oldStatus;

      // Strip ephemeral Vertex grounding redirect URLs — they expire within hours
      const stableEvidenceUrls = (searchData?.evidence_urls || [])
        .filter(u => !String(u).includes('vertexaisearch.cloud.google.com'));

      await Promise.resolve(vdb.upsertVerification({
        claim_id:           claim.claim_id,
        claim_source:       claim.claim_source,
        claim_text:         claim.claim_text,
        confidence_score:   result.confidence,
        scoring_breakdown:  result.breakdown,
        status:             result.suggested_status,
        web_search_summary: searchData?.summary || null,
        evidence_urls:      stableEvidenceUrls.length ? stableEvidenceUrls : null,
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
      }));

      if (statusChanged) {
        await Promise.resolve(vdb.logAudit({
          claim_id:            claim.claim_id,
          claim_source:        claim.claim_source,
          old_status:          oldStatus,
          new_status:          result.suggested_status,
          confidence_score:    result.confidence,
          scoring_breakdown:   result.breakdown,
          verification_method: searchData ? 'web_search' : 'auto_score',
          evidence_urls:       searchData?.evidence_urls || null,
          notes:               searchData?.summary || `Auto-scored: ${result.confidence.toFixed(3)}`,
        }));

        if (claim.claim_source === 'tracker' && result.suggested_status !== 'unverified') {
          const note = searchData
            ? `[auto-verified] ${result.suggested_status} (${Math.round(result.confidence * 100)}%): ${searchData.summary?.slice(0, 100) || ''}`
            : `[auto-scored] ${result.suggested_status} (${Math.round(result.confidence * 100)}%)`;
          updateTrackerClaim(claim.claim_id, result.suggested_status, note);
          log(`tracker updated: ${claim.claim_id} → ${result.suggested_status}`);
        }
      }
    };

    if (DB_IS_PG) {
      await vdb.runTransaction(async () => {
        for (const row of results) {
          await persistOne(row);
        }
      });
    } else {
      vdb.runTransaction(() => {
        for (const row of results) {
          const searchData = row.claim._searchData;
          const statusChanged = row.result.suggested_status !== row.oldStatus;

          const stableEvidenceUrls = (searchData?.evidence_urls || [])
            .filter(u => !String(u).includes('vertexaisearch.cloud.google.com'));

          vdb.upsertVerification({
            claim_id:           row.claim.claim_id,
            claim_source:       row.claim.claim_source,
            claim_text:         row.claim.claim_text,
            confidence_score:   row.result.confidence,
            scoring_breakdown:  row.result.breakdown,
            status:             row.result.suggested_status,
            web_search_summary: searchData?.summary || null,
            evidence_urls:      stableEvidenceUrls.length ? stableEvidenceUrls : null,
            source_handle:      row.handle || row.claim.source_handle || null,
            source_tier:        row.claim.source_tier || null,
            related_axis_id:    row.claim.related_axis_id || null,
            category:           row.claim.category || null,
            original_source:    searchData?.original_source || null,
            claim_date:         searchData?.claim_date || null,
            supporting_sources: searchData?.supporting_sources || null,
            dissenting_sources: searchData?.dissenting_sources || null,
            framing_analysis:   searchData?.framing_analysis || null,
            created_at:         row.claim.created_at,
          });

          if (statusChanged) {
            vdb.logAudit({
              claim_id:            row.claim.claim_id,
              claim_source:        row.claim.claim_source,
              old_status:          row.oldStatus,
              new_status:          row.result.suggested_status,
              confidence_score:    row.result.confidence,
              scoring_breakdown:   row.result.breakdown,
              verification_method: searchData ? 'web_search' : 'auto_score',
              evidence_urls:       searchData?.evidence_urls || null,
              notes:               searchData?.summary || `Auto-scored: ${row.result.confidence.toFixed(3)}`,
            });

            if (row.claim.claim_source === 'tracker' && row.result.suggested_status !== 'unverified') {
              const note = searchData
                ? `[auto-verified] ${row.result.suggested_status} (${Math.round(row.result.confidence * 100)}%): ${searchData.summary?.slice(0, 100) || ''}`
                : `[auto-scored] ${row.result.suggested_status} (${Math.round(row.result.confidence * 100)}%)`;
              updateTrackerClaim(row.claim.claim_id, row.result.suggested_status, note);
              log(`tracker updated: ${row.claim.claim_id} → ${row.result.suggested_status}`);
            }
          }
        }
      });
    }

    log(`scored ${results.length} claims, web-searched ${webSearchCount}`);

    // 6. Process expiry
    await processExpiry();

    // 7. Export for web
    await exportVerificationData();
  } else {
    log(`[dry-run] would persist ${results.length} results`);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────
run().catch(err => {
  log(`fatal: ${err.message}`);
  process.exit(0);  // non-fatal — don't block pipeline
});
