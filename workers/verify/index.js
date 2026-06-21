#!/usr/bin/env node
/**
 * workers/verify/index.js — Verification worker (Cloud Run HTTP service)
 *
 * Stateless claim verification service. Receives tasks via HTTP from Cloud Tasks
 * or direct invocation. Uses Postgres for state, Vertex AI for web search,
 * publishes to Pub/Sub when claims resolve.
 *
 * Endpoints:
 *   POST /verify-cycle   — Run full verification cycle (score + web search top claim)
 *   POST /verify-claim   — Verify a single claim by ID
 *   GET  /health         — Health check
 *
 * Env vars:
 *   DATABASE_URL         — Postgres connection string
 *   GCP_PROJECT          — GCP project ID (for Vertex AI + Pub/Sub)
 *   GCP_LOCATION         — Vertex AI region (default: us-central1)
 *   CLAIM_TRACKER_URL    — GCS URL for claim_tracker.json (optional)
 *   PG_SSL               — set to 'false' for same-VPC connections
 */

'use strict';

const http = require('http');
const { PubSub } = require('@google-cloud/pubsub');

// ── Structured logging (Cloud Logging format) ──────────────────────────────
// Cloud Run pipes stdout JSON to Cloud Logging with severity + labels.
function structLog(severity, message, fields = {}) {
  const entry = {
    severity,
    message,
    component: 'verify-worker',
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

// ── Pub/Sub ─────────────────────────────────────────────────────────────────

const pubsub = new PubSub({ projectId: process.env.GCP_PROJECT || 'sebastian-hunter' });
const claimResolvedTopic = pubsub.topic('claim-resolved');
const cycleCompleteTopic = pubsub.topic('cycle-complete');

async function publishClaimResolved(claim, result) {
  try {
    await claimResolvedTopic.publishMessage({
      json: {
        claim_id: claim.claim_id,
        claim_text: claim.claim_text,
        old_status: claim._oldStatus,
        new_status: result.suggested_status,
        confidence: result.confidence,
        summary: claim._searchData?.summary || null,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    log.error('pubsub publish failed', { error: err.message });
  }
}

// ── Claim scorer (inline — pure function, no deps) ─────────────────────────

const WEIGHTS = {
  source_tier: 0.30,
  newsguard: 0.15,
  corroboration: 0.20,
  evidence_quality: 0.15,
  cross_source: 0.10,
  web_search: 0.10,
};

function scoreClaim(claim, sourceData) {
  const tier = claim.source_tier || sourceData?.credibility_tier || 5;
  const ngScore = sourceData?.ng_score || null;

  const breakdown = {
    source_tier: (6 - tier) / 5,
    newsguard: ngScore != null ? ngScore / 100 : 0.5,
    corroboration: Math.min((claim.corroborating_count || 0) / 3, 1.0),
    evidence_quality: claim.cited_url ? (tier <= 2 ? 1.0 : 0.5) : 0.0,
    cross_source: 1 - ((claim.contradicting_count || 0) /
      Math.max((claim.corroborating_count || 0) + (claim.contradicting_count || 0), 1)),
    web_search: ({ confirmed: 1.0, partial: 0.8, inconclusive: 0.5, refuted: 0.0, no_results: 0.5 }
      [claim.web_search_result] || 0.5),
  };

  let confidence = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    confidence += breakdown[key] * weight;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  let suggested_status = 'unverified';
  if (confidence >= 0.75 && claim.web_search_result === 'confirmed') {
    suggested_status = 'supported';
  } else if (confidence <= 0.25 || claim.web_search_result === 'refuted') {
    suggested_status = 'refuted';
  } else if ((claim.contradicting_count || 0) > 0 && claim.web_search_result) {
    suggested_status = 'contested';
  }

  return { confidence, breakdown, suggested_status };
}

// ── Web search via Vertex AI ────────────────────────────────────────────────

async function webSearchVerify(claimText) {
  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token;

    const project = process.env.GCP_PROJECT || 'sebastian-hunter';
    const location = process.env.GCP_LOCATION || 'us-central1';
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`;

    const prompt = [
      'You are a fact-checker and claim analyst. Evaluate the following claim using current information.',
      '', `CLAIM: "${claimText}"`, '',
      'Search for evidence about this claim. Then respond with ONLY valid JSON (no markdown, no code fences):',
      '{',
      '  "verdict": "confirmed" | "refuted" | "partial" | "inconclusive" | "no_results",',
      '  "summary": "2-3 sentence explanation of findings",',
      '  "evidence_urls": ["url1", "url2"],',
      '  "original_source": "who first made or reported this claim",',
      '  "claim_date": "approximate date (YYYY-MM-DD or YYYY-MM)",',
      '  "supporting_sources": [{"name": "source name", "stance": "brief position"}],',
      '  "dissenting_sources": [{"name": "source name", "stance": "brief counter-position"}],',
      '  "framing_analysis": "Is this a valid category or false dichotomy? 1-2 sentences."',
      '}',
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        }),
      });

      if (!res.ok) return null;

      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
      const groundingUrls = (data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
        .filter(c => c.web?.uri).map(c => c.web.uri);

      let parsed;
      try {
        let clean = text.replace(/```json\s*\n?/gi, '').replace(/```\s*/g, '').trim();
        const m = clean.match(/\{[\s\S]*\}/);
        if (m) clean = m[0];
        parsed = JSON.parse(clean);
      } catch {
        return { web_search_result: 'inconclusive', summary: text.slice(0, 500), evidence_urls: groundingUrls };
      }

      return {
        web_search_result: parsed.verdict || 'inconclusive',
        summary: parsed.summary || '',
        evidence_urls: [...new Set([...(parsed.evidence_urls || []), ...groundingUrls])].slice(0, 5),
        original_source: parsed.original_source || null,
        claim_date: parsed.claim_date || null,
        supporting_sources: parsed.supporting_sources || [],
        dissenting_sources: parsed.dissenting_sources || [],
        framing_analysis: parsed.framing_analysis || null,
      };
    } finally { clearTimeout(timer); }
  } catch (err) {
    log.error('web search failed', { error: err.message });
    return null;
  }
}

// ── DB helpers ──────────────────────────────────────────────────────────────

function parseRow(row) {
  if (!row) return null;
  row.scoring_breakdown = row.scoring_breakdown ? JSON.parse(row.scoring_breakdown) : {};
  row.evidence_urls = row.evidence_urls ? JSON.parse(row.evidence_urls) : [];
  row.supporting_sources = row.supporting_sources ? JSON.parse(row.supporting_sources) : [];
  row.dissenting_sources = row.dissenting_sources ? JSON.parse(row.dissenting_sources) : [];
  return row;
}

async function getVerification(claimId) {
  const { rows } = await query('SELECT * FROM claim_verifications WHERE claim_id = $1', [claimId]);
  return parseRow(rows[0]) || null;
}

async function getUnverified() {
  const { rows } = await query(
    "SELECT * FROM claim_verifications WHERE status IN ('unverified', 'contested') ORDER BY confidence_score DESC"
  );
  return rows.map(parseRow);
}

async function getAllVerifications() {
  const { rows } = await query(`
    SELECT * FROM claim_verifications ORDER BY
      CASE status WHEN 'supported' THEN 1 WHEN 'refuted' THEN 2 WHEN 'contested' THEN 3
        WHEN 'unverified' THEN 4 WHEN 'expired' THEN 5 END,
      confidence_score DESC
  `);
  return rows.map(parseRow);
}

async function upsertVerification(r) {
  const now = new Date().toISOString();
  await query(`
    INSERT INTO claim_verifications (
      claim_id, claim_source, claim_text, confidence_score, scoring_breakdown,
      status, verification_count, last_verified_at, web_search_summary,
      evidence_urls, source_handle, source_tier, related_axis_id, category,
      original_source, claim_date, supporting_sources, dissenting_sources, framing_analysis,
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT(claim_id) DO UPDATE SET
      confidence_score = $4, scoring_breakdown = $5, status = $6,
      verification_count = claim_verifications.verification_count + 1,
      last_verified_at = $7,
      web_search_summary = COALESCE($8, claim_verifications.web_search_summary),
      evidence_urls = COALESCE($9, claim_verifications.evidence_urls),
      original_source = COALESCE($14, claim_verifications.original_source),
      claim_date = COALESCE($15, claim_verifications.claim_date),
      supporting_sources = COALESCE($16, claim_verifications.supporting_sources),
      dissenting_sources = COALESCE($17, claim_verifications.dissenting_sources),
      framing_analysis = COALESCE($18, claim_verifications.framing_analysis),
      updated_at = $20
  `, [
    r.claim_id, r.claim_source, r.claim_text, r.confidence_score,
    JSON.stringify(r.scoring_breakdown), r.status, now,
    r.web_search_summary || null,
    r.evidence_urls ? JSON.stringify(r.evidence_urls) : null,
    r.source_handle || null, r.source_tier || null,
    r.related_axis_id || null, r.category || null,
    r.original_source || null, r.claim_date || null,
    r.supporting_sources ? JSON.stringify(r.supporting_sources) : null,
    r.dissenting_sources ? JSON.stringify(r.dissenting_sources) : null,
    r.framing_analysis || null, r.created_at || now, now,
  ]);
}

async function logAudit(r) {
  await query(`
    INSERT INTO claim_audit_log (claim_id, claim_source, old_status, new_status,
      confidence_score, scoring_breakdown, verification_method, evidence_urls, notes, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [
    r.claim_id, r.claim_source, r.old_status || null, r.new_status,
    r.confidence_score, JSON.stringify(r.scoring_breakdown),
    r.verification_method || 'auto_score',
    r.evidence_urls ? JSON.stringify(r.evidence_urls) : null,
    r.notes || null, new Date().toISOString(),
  ]);
}

// ── Verify cycle handler ────────────────────────────────────────────────────

const MAX_CLAIMS = 10;
const WEB_SEARCH_PER_CYCLE = 1;

async function runVerifyCycle() {
  log.info('starting verification cycle');

  // Load claims from DB
  const claims = await getUnverified();
  if (claims.length === 0) {
    log.info('no unverified claims');
    return { scored: 0, searched: 0 };
  }

  log.info('claims to verify', { count: claims.length });
  const batch = claims.slice(0, MAX_CLAIMS);

  let webSearchCount = 0;
  const results = [];

  // Score all claims
  for (const claim of batch) {
    // Load source data from Postgres
    let sourceData = {};
    if (claim.source_handle) {
      const { rows } = await query(
        'SELECT credibility_tier, ng_score FROM sources WHERE handle = $1',
        [claim.source_handle]
      );
      if (rows[0]) sourceData = rows[0];
    }

    const result = scoreClaim(claim, sourceData);
    claim._oldStatus = claim.status;
    results.push({ claim, result, sourceData });
  }

  // Web search top priority claim
  for (const { claim, result, sourceData } of results) {
    if (webSearchCount >= WEB_SEARCH_PER_CYCLE) break;

    // Skip if searched recently
    if (claim.last_verified_at) {
      const last = new Date(claim.last_verified_at).getTime();
      if (Date.now() - last < 24 * 3600_000) continue;
    }

    log.info('web searching claim', { claim_id: claim.claim_id, text: (claim.claim_text || '').slice(0, 80) });
    const searchData = await webSearchVerify(claim.claim_text);
    webSearchCount++;

    if (searchData) {
      claim.web_search_result = searchData.web_search_result;
      const updated = scoreClaim(claim, sourceData);
      Object.assign(result, updated);
      claim._searchData = searchData;
      log.info('web search result', { verdict: searchData.web_search_result, status: updated.suggested_status, confidence: Math.round(updated.confidence * 100) });
    }
  }

  // Persist
  for (const { claim, result } of results) {
    const searchData = claim._searchData;
    const statusChanged = result.suggested_status !== claim._oldStatus;

    await upsertVerification({
      claim_id: claim.claim_id,
      claim_source: claim.claim_source || 'tracker',
      claim_text: claim.claim_text,
      confidence_score: result.confidence,
      scoring_breakdown: result.breakdown,
      status: result.suggested_status,
      web_search_summary: searchData?.summary || null,
      evidence_urls: searchData?.evidence_urls || null,
      source_handle: claim.source_handle || null,
      source_tier: claim.source_tier || null,
      related_axis_id: claim.related_axis_id || null,
      category: claim.category || null,
      original_source: searchData?.original_source || null,
      claim_date: searchData?.claim_date || null,
      supporting_sources: searchData?.supporting_sources || null,
      dissenting_sources: searchData?.dissenting_sources || null,
      framing_analysis: searchData?.framing_analysis || null,
      created_at: claim.created_at,
    });

    if (statusChanged) {
      await logAudit({
        claim_id: claim.claim_id,
        claim_source: claim.claim_source || 'tracker',
        old_status: claim._oldStatus,
        new_status: result.suggested_status,
        confidence_score: result.confidence,
        scoring_breakdown: result.breakdown,
        verification_method: searchData ? 'web_search' : 'auto_score',
        evidence_urls: searchData?.evidence_urls || null,
        notes: searchData?.summary || `Auto-scored: ${result.confidence.toFixed(3)}`,
      });

      // Publish resolved claim event
      if (result.suggested_status === 'supported' || result.suggested_status === 'refuted') {
        await publishClaimResolved(claim, result);
      }
    }
  }

  // Publish cycle complete
  try {
    await cycleCompleteTopic.publishMessage({
      json: { scored: results.length, searched: webSearchCount, timestamp: new Date().toISOString() },
    });
  } catch {}

  log.info('cycle complete', { scored: results.length, searched: webSearchCount });
  return { scored: results.length, searched: webSearchCount };
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

    if (method === 'POST' && url === '/verify-cycle') {
      const result = await runVerifyCycle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (method === 'POST' && url === '/verify-claim') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { claim_id } = JSON.parse(body);

      const existing = await getVerification(claim_id);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'claim not found' }));
        return;
      }

      // Web search this specific claim
      const searchData = await webSearchVerify(existing.claim_text);
      if (searchData) {
        existing.web_search_result = searchData.web_search_result;
        const result = scoreClaim(existing, {});
        await upsertVerification({
          ...existing,
          confidence_score: result.confidence,
          scoring_breakdown: result.breakdown,
          status: result.suggested_status,
          web_search_summary: searchData.summary,
          evidence_urls: searchData.evidence_urls,
          original_source: searchData.original_source,
          claim_date: searchData.claim_date,
          supporting_sources: searchData.supporting_sources,
          dissenting_sources: searchData.dissenting_sources,
          framing_analysis: searchData.framing_analysis,
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ claim_id, searched: !!searchData }));
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  log.info('worker started', { port: PORT });
});
