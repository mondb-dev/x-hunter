#!/usr/bin/env node
/**
 * runner/intelligence/claim_scorer.js — composite confidence scoring for claims
 *
 * Pure scoring module with no side effects. Computes a 0.0–1.0 confidence score
 * from six weighted components: source tier, NewsGuard, corroboration, evidence
 * quality, cross-source agreement, and web search results.
 *
 * Exports:
 *   scoreClaim(claim, sourceData)  → { confidence, breakdown, suggested_status }
 *   WEIGHTS                        → { source_tier, newsguard, ... }
 *   STATUS_THRESHOLDS              → { supported, refuted }
 *
 * Usage:
 *   node runner/intelligence/claim_scorer.js --test   # run built-in tests
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Weights ─────────────────────────────────────────────────────────────────
const WEIGHTS = {
  source_tier:      0.30,
  newsguard:        0.15,
  corroboration:    0.20,
  evidence_quality: 0.15,
  cross_source:     0.10,
  web_search:       0.10,
};

// ── Thresholds ──────────────────────────────────────────────────────────────
const STATUS_THRESHOLDS = {
  supported: 0.75,   // >= this + web search confirms → supported
  refuted:   0.25,   // <= this or web search refutes → refuted
};

// ── High-tier domains (derived from source_registry.json) ───────────────────
// Built dynamically from tier 1-2 accounts in the registry.
// Maps handle → likely website domain so grounding metadata can be matched.
// Falls back to a small seed set for domains that don't map 1:1 from handles.

const HANDLE_TO_DOMAIN = {
  reuters: 'reuters.com', ap: 'apnews.com', apnews: 'apnews.com',
  bbc: 'bbc.com', bbcbreaking: 'bbc.com', cnn: 'cnn.com',
  foxnews: 'foxnews.com', ajenglish: 'aljazeera.com', aljazeera: 'aljazeera.com',
  nytimes: 'nytimes.com', washingtonpost: 'washingtonpost.com',
  theguardian: 'theguardian.com', wsj: 'wsj.com', ft: 'ft.com',
  axios: 'axios.com', politico: 'politico.com', thehill: 'thehill.com',
  haaretz: 'haaretz.com', timesofisrael: 'timesofisrael.com',
  cbsnews: 'cbsnews.com', nbcnews: 'nbcnews.com', skynews: 'news.sky.com',
  dailymail: 'dailymail.co.uk',
};

// Additional known-credible domains not tied to a Twitter handle
const SEED_DOMAINS = [
  'wikipedia.org', 'bbc.co.uk', 'abcnews.go.com', 'economist.com',
  'france24.com', 'dw.com', 'middleeastmonitor.com',
];

function buildHighTierDomains(registryPath) {
  const domains = new Set(SEED_DOMAINS);

  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const accounts = registry.accounts || {};
    for (const [handle, data] of Object.entries(accounts)) {
      if (data.credibility_tier <= 2) {
        // Use explicit mapping if available, else try handle + .com
        const domain = HANDLE_TO_DOMAIN[handle.toLowerCase()];
        if (domain) domains.add(domain);
      }
    }
  } catch {
    // Registry not found — use handle mappings as fallback
    for (const d of Object.values(HANDLE_TO_DOMAIN)) domains.add(d);
  }

  return domains;
}

const REGISTRY_PATH = path.resolve(__dirname, '../../state/source_registry.json');
const HIGH_TIER_DOMAINS = buildHighTierDomains(REGISTRY_PATH);

// ── Component scorers ───────────────────────────────────────────────────────

/**
 * Source tier score: Tier 1 = 1.0, Tier 5 = 0.2
 * Returns 0.5 if tier is missing or invalid.
 */
function scoreSourceTier(tier) {
  if (!tier || tier < 1 || tier > 5) return 0.5;
  return (6 - tier) / 5;
}

/**
 * NewsGuard score: ng_score / 100
 * Returns 0.5 if missing.
 */
function scoreNewsGuard(ngScore) {
  if (ngScore == null || ngScore < 0) return 0.5;
  return Math.min(ngScore / 100, 1.0);
}

/**
 * Corroboration: saturates at 3 corroborating sources.
 */
function scoreCorroboration(corroboratingCount) {
  if (!corroboratingCount || corroboratingCount < 0) return 0.0;
  return Math.min(corroboratingCount / 3, 1.0);
}

/**
 * Evidence quality:
 *   0.0 — no URL at all
 *   0.5 — has a URL but from unknown or low-tier domain
 *   1.0 — URL from a Tier 1-2 domain
 */
function scoreEvidenceQuality(citedUrl, citedDomain) {
  if (!citedUrl) return 0.0;
  if (!citedDomain) return 0.5;
  const normalizedDomain = citedDomain.toLowerCase().replace(/^www\./, '');
  return HIGH_TIER_DOMAINS.has(normalizedDomain) ? 1.0 : 0.5;
}

/**
 * Cross-source agreement:
 *   1.0 when no contradictions; 0.0 when all sources contradict.
 */
function scoreCrossSource(corroboratingCount, contradictingCount) {
  const corr = corroboratingCount || 0;
  const contra = contradictingCount || 0;
  const total = corr + contra;
  if (total === 0) return 0.5;  // no data → neutral
  return 1.0 - (contra / total);
}

/**
 * Web search result score:
 *   0.0 — not searched yet
 *   0.3 — searched, no relevant results
 *   0.5 — inconclusive
 *   0.8 — partial match (some supporting evidence)
 *   1.0 — strong confirmation
 *  -1.0 — strong refutation (special: triggers refuted path)
 *
 * The web_search_result field is set by verify_claims.js after running a search.
 */
function scoreWebSearch(webSearchResult) {
  if (webSearchResult == null) return 0.0;
  // Clamp to valid range
  if (typeof webSearchResult === 'number') {
    return Math.max(-1.0, Math.min(1.0, webSearchResult));
  }
  // Accept string labels
  const labels = {
    'not_searched': 0.0,
    'no_results': 0.3,
    'inconclusive': 0.5,
    'partial': 0.8,
    'confirmed': 1.0,
    'refuted': -1.0,
  };
  return labels[webSearchResult] ?? 0.0;
}

// ── Web search boost ─────────────────────────────────────────────────────────
// When web search confirms a claim with grounded evidence (evidence_urls from
// credible sources), the confirmation itself IS corroboration and evidence.
// Without this boost, claims confirmed by Wikipedia + Reuters + Guardian still
// score 38% because the DB has no corroboration/evidence metadata — the web
// search already proved those things.
//
// Boost conditions (all must be true):
//   1. Web search returned "confirmed" or "partial" (score >= 0.8)
//   2. Claim has evidence_urls (grounded, not hallucinated)
//   3. Source is credible (Tier 1-3) OR source is unknown (not Tier 4-5)
//
// Effect: fills corroboration and evidence_quality to at least 0.7 when they
// would otherwise be 0 due to missing DB metadata.

function applyWebSearchBoost(breakdown, claim) {
  if (breakdown.web_search < 0.8) return;  // only confirmed/partial

  const evidenceUrls = claim.evidence_urls || claim._evidence_urls || [];
  const evidenceDomains = claim.evidence_domains || [];
  if (evidenceUrls.length === 0 && evidenceDomains.length === 0) return;  // no grounded evidence

  const tier = claim.source_tier;
  if (tier && tier >= 4) return;  // low-credibility source, don't boost

  // Count how many evidence sources are from high-tier domains
  let highTierCount = 0;
  // Check actual URLs
  for (const url of evidenceUrls) {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      if (HIGH_TIER_DOMAINS.has(domain)) highTierCount++;
    } catch {}
  }
  // Check domain names from grounding metadata (covers redirect URLs)
  for (const d of evidenceDomains) {
    const clean = d.replace(/^www\./, '').toLowerCase();
    if (HIGH_TIER_DOMAINS.has(clean)) highTierCount++;
  }

  // Strong boost: confirmed + multiple high-tier sources
  // Moderate boost: confirmed + any evidence URLs
  const boostLevel = highTierCount >= 2 ? 0.9 : highTierCount >= 1 ? 0.8 : 0.7;

  // Lift corroboration — web search found supporting sources
  if (breakdown.corroboration < boostLevel) {
    breakdown.corroboration = boostLevel;
  }

  // Lift evidence quality — web search provided grounded URLs
  if (breakdown.evidence_quality < boostLevel) {
    breakdown.evidence_quality = boostLevel;
  }
}

// ── Main scorer ─────────────────────────────────────────────────────────────

/**
 * Score a claim and return confidence + breakdown + suggested status.
 *
 * @param {object} claim — must have:
 *   - source_tier {number|null}
 *   - corroborating_count {number|null}
 *   - contradicting_count {number|null}
 *   - cited_url {string|null}
 *   - cited_domain {string|null}
 *   - web_search_result {number|string|null} — set by verification pipeline
 *   - evidence_urls {string[]|null} — set by web search (grounding URLs)
 *
 * @param {object} sourceData — optional enrichment from source_registry:
 *   - ng_score {number|null}
 *   - credibility_tier {number|null} — overrides claim.source_tier if present
 *
 * @returns {{ confidence: number, breakdown: object, suggested_status: string }}
 */
function scoreClaim(claim, sourceData = {}) {
  const tier = sourceData.credibility_tier || claim.source_tier || null;
  const ngScore = sourceData.ng_score ?? null;

  const breakdown = {
    source_tier:      scoreSourceTier(tier),
    newsguard:        scoreNewsGuard(ngScore),
    corroboration:    scoreCorroboration(claim.corroborating_count),
    evidence_quality: scoreEvidenceQuality(claim.cited_url, claim.cited_domain),
    cross_source:     scoreCrossSource(claim.corroborating_count, claim.contradicting_count),
    web_search:       scoreWebSearch(claim.web_search_result),
  };

  // Apply web search boost before computing weighted sum
  applyWebSearchBoost(breakdown, { ...claim, source_tier: tier });

  // Web search refutation overrides the normal scoring
  const webRefuted = breakdown.web_search < 0;

  // Compute weighted sum (use absolute value of web_search for the weight calc)
  let confidence = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const componentScore = key === 'web_search' ? Math.abs(breakdown[key]) : breakdown[key];
    confidence += componentScore * weight;
  }
  confidence = Math.round(confidence * 1000) / 1000;  // 3 decimal places

  // Determine suggested status
  // Key principle: "refuted" requires active refutation evidence, not just low confidence.
  // A claim with no data is "unverified", not "refuted".
  let suggested_status = 'unverified';
  const hasWebEvidence = breakdown.web_search !== 0;

  if (webRefuted) {
    suggested_status = 'refuted';
  } else if (confidence >= STATUS_THRESHOLDS.supported && breakdown.web_search >= 0.8) {
    suggested_status = 'supported';
  } else if (confidence <= STATUS_THRESHOLDS.refuted && breakdown.web_search < 0) {
    // Only refute via low confidence if web search actively found counter-evidence.
    // "Inconclusive" (0.5) or "no_results" (0.3) is NOT refutation — it just means
    // we don't have enough data, which is "unverified".
    suggested_status = 'refuted';
  } else if (claim.contradicting_count > 0 && claim.corroborating_count > 0) {
    suggested_status = 'contested';
  }

  return { confidence, breakdown, suggested_status };
}

// ── Exports ─────────────────────────────────────────────────────────────────
module.exports = { scoreClaim, WEIGHTS, STATUS_THRESHOLDS, HIGH_TIER_DOMAINS };

// ── Built-in tests ──────────────────────────────────────────────────────────
if (process.argv.includes('--test')) {
  const assert = (cond, msg) => {
    if (!cond) { console.error('FAIL:', msg); process.exit(1); }
    console.log('PASS:', msg);
  };

  // Test 1: Tier 1 source with full corroboration and confirmed web search
  const r1 = scoreClaim({
    source_tier: 1,
    corroborating_count: 5,
    contradicting_count: 0,
    cited_url: 'https://reuters.com/article/test',
    cited_domain: 'reuters.com',
    web_search_result: 'confirmed',
  }, { ng_score: 100, credibility_tier: 1 });
  assert(r1.confidence >= 0.9, `high-quality claim scores >= 0.9 (got ${r1.confidence})`);
  assert(r1.suggested_status === 'supported', `high-quality → supported (got ${r1.suggested_status})`);

  // Test 2: Tier 5 source with no corroboration, no URL
  const r2 = scoreClaim({
    source_tier: 5,
    corroborating_count: 0,
    contradicting_count: 0,
    cited_url: null,
    cited_domain: null,
    web_search_result: null,
  }, {});
  assert(r2.confidence < 0.4, `low-quality claim scores < 0.4 (got ${r2.confidence})`);
  assert(r2.suggested_status === 'unverified', `low-quality → unverified (got ${r2.suggested_status})`);

  // Test 3: Web search refutation overrides high score
  const r3 = scoreClaim({
    source_tier: 1,
    corroborating_count: 3,
    contradicting_count: 0,
    cited_url: 'https://bbc.com/news/test',
    cited_domain: 'bbc.com',
    web_search_result: 'refuted',
  }, { ng_score: 100 });
  assert(r3.suggested_status === 'refuted', `web refutation overrides → refuted (got ${r3.suggested_status})`);

  // Test 4: Contested claim (has both corroboration and contradiction)
  const r4 = scoreClaim({
    source_tier: 3,
    corroborating_count: 2,
    contradicting_count: 2,
    cited_url: 'https://example.com/article',
    cited_domain: 'example.com',
    web_search_result: 'inconclusive',
  }, { ng_score: 60 });
  assert(r4.suggested_status === 'contested', `mixed evidence → contested (got ${r4.suggested_status})`);

  // Test 5: Scores are in valid range
  const r5 = scoreClaim({
    source_tier: null,
    corroborating_count: null,
    contradicting_count: null,
    cited_url: null,
    cited_domain: null,
    web_search_result: null,
  }, {});
  assert(r5.confidence >= 0 && r5.confidence <= 1, `null inputs produce valid score (got ${r5.confidence})`);

  // Test 6: Breakdown keys match weights
  const keys = Object.keys(r1.breakdown).sort();
  const weightKeys = Object.keys(WEIGHTS).sort();
  assert(JSON.stringify(keys) === JSON.stringify(weightKeys), 'breakdown keys match weight keys');

  console.log('\nAll tests passed.');
}
