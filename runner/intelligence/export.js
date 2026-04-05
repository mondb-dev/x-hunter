'use strict';

/**
 * runner/intelligence/export.js
 *
 * Reads state/intelligence.db + state/ontology.json
 * Writes state/intelligence_export.json
 *
 * Structure:
 *   topic, topic_label, generated_at, source_count, claim_count
 *   categories: { <catId>: { label, claim_count, claims[] } }
 *   contradictions: []
 *   source_summary: { tier_1..tier_5: { count, handles[] } }
 *   axis_scores: { <axis_id>: { score, confidence, label, left_pole, right_pole } }
 *   sebastians_take: { article_refs[], summary }
 *
 * Usage: node runner/intelligence/export.js [--topic iran-us-israel]
 */

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const db = require('./db');
const { TOPICS } = require('./topics');

const TOPIC_ID = 'iran-us-israel';
const MAX_PER_CATEGORY = 50;
const EXPORT_PATH = path.join(config.STATE_DIR, 'intelligence_export.json');

const CATEGORY_ORDER = [
  'military_action',
  'nuclear',
  'diplomatic',
  'casualties_humanitarian',
  'proxy_regional',
  'threats_claims',
  'internal_politics',
  'misc',
];

const CATEGORY_LABELS = {
  military_action: 'Military Action',
  nuclear: 'Nuclear Program',
  diplomatic: 'Diplomacy & Negotiations',
  casualties_humanitarian: 'Casualties & Humanitarian',
  proxy_regional: 'Proxy Forces & Regional',
  threats_claims: 'Threats & Claims',
  internal_politics: 'Internal Politics',
  misc: 'Miscellaneous',
};

function log(msg) {
  console.log(`[export] ${msg}`);
}

// ── Axis scores from ontology ─────────────────────────────────────────────────
function getAxisScores(topicConfig) {
  const ontology = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf8'));
  const result = {};

  for (const axisId of topicConfig.topic_axes) {
    const axis = (ontology.axes || []).find(a => a.id === axisId);
    if (!axis) continue;
    result[axisId] = {
      score:      axis.score      ?? 0,
      confidence: axis.confidence ?? 0,
      label:      axis.label      ?? axisId,
      left_pole:  axis.left_pole  ?? '',
      right_pole: axis.right_pole ?? '',
    };
  }

  return result;
}

// ── Sebastian's take from recent articles ─────────────────────────────────────
const ARTICLES_DIR = path.join(config.PROJECT_ROOT, 'articles');
const IRAN_KEYWORDS = [
  'iran', 'israel', 'idf', 'nuclear', 'tehran', 'gaza', 'hezbollah',
  'hamas', 'houthi', 'war', 'strike', 'missile', 'uranium', 'natanz',
];

function getSebastiansTake() {
  if (!fs.existsSync(ARTICLES_DIR)) return { article_refs: [], summary: '' };

  const files = fs.readdirSync(ARTICLES_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, 20);

  const relevant = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf8');
    const lower = content.toLowerCase();
    const hits = IRAN_KEYWORDS.filter(kw => lower.includes(kw)).length;
    if (hits >= 2) {
      relevant.push({ file, content, hits });
    }
  }

  if (!relevant.length) return { article_refs: [], summary: '' };

  // Sort by keyword hits desc
  relevant.sort((a, b) => b.hits - a.hits);
  const top = relevant.slice(0, 3);

  // Extract first meaningful sentences from top article
  const mainContent = top[0].content
    .replace(/^#.*$/gm, '') // strip headings
    .replace(/\[.*?\]\(.*?\)/g, '') // strip links
    .trim();

  const sentences = mainContent
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 40 && s.length < 300)
    .slice(0, 3);

  const summary = sentences.join(' ');

  const article_refs = top.map(({ file }) => {
    const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
    return {
      date: dateMatch ? dateMatch[1] : file.replace('.md', ''),
      url: `https://sebastianhunter.fun/articles/${file.replace('.md', '')}`,
    };
  });

  return { article_refs, summary };
}

// ── Build contradictions from claim groups ────────────────────────────────────
function buildContradictions() {
  const groups = db.prepare(
    'SELECT * FROM claim_groups WHERE topic = ? ORDER BY min_tier ASC'
  ).all(TOPIC_ID);

  const contradictions = [];

  for (const group of groups) {
    let claimIds;
    try { claimIds = JSON.parse(group.claim_ids || '[]'); } catch { continue; }
    if (claimIds.length < 2) continue;

    if (!claimIds.length) continue;
    const placeholders = claimIds.map(() => '?').join(',');
    const groupClaims = db.prepare(
      `SELECT * FROM claims WHERE id IN (${placeholders})`
    ).all(...claimIds);

    if (groupClaims.length < 2) continue;

    // Check for credible (tier≤2) AND contested (tier≥4) with opposing stances
    const credible = groupClaims.filter(c => (c.source_tier ?? 5) <= 2);
    const contested = groupClaims.filter(c => (c.source_tier ?? 5) >= 4);

    if (!credible.length || !contested.length) continue;

    // Check opposing stances
    const credibleStances = new Set(credible.map(c => c.stance));
    const contestedStances = new Set(contested.map(c => c.stance));
    const hasOpposing = (credibleStances.has('left') && contestedStances.has('right')) ||
                        (credibleStances.has('right') && contestedStances.has('left'));

    if (!hasOpposing) continue;

    const credibleSide = credible[0];
    const contestedSide = contested[0];

    contradictions.push({
      group_id: group.group_id,
      category: group.category,
      sides: [
        {
          stance: credibleSide.stance,
          source_handle: credibleSide.source_handle,
          source_tier: credibleSide.source_tier,
          source_tier_label: credibleSide.source_tier_label,
          claim_text: credibleSide.claim_text,
        },
        {
          stance: contestedSide.stance,
          source_handle: contestedSide.source_handle,
          source_tier: contestedSide.source_tier,
          source_tier_label: contestedSide.source_tier_label,
          claim_text: contestedSide.claim_text,
        },
      ],
    });
  }

  return contradictions;
}

// ── Build source summary by tier ──────────────────────────────────────────────
function buildSourceSummary() {
  // Get sources that appear in claims
  const sourcesInClaims = db.prepare(`
    SELECT DISTINCT source_handle FROM claims WHERE topic = ? AND source_handle IS NOT NULL
  `).all(TOPIC_ID).map(r => r.source_handle);

  const summary = { tier_1: null, tier_2: null, tier_3: null, tier_4: null, tier_5: null };

  for (let tier = 1; tier <= 5; tier++) {
    const key = `tier_${tier}`;
    // Tier 5 bucket includes NULLs
    const sources = tier < 5
      ? db.prepare('SELECT * FROM sources WHERE credibility_tier = ? ORDER BY handle').all(tier)
      : db.prepare('SELECT * FROM sources WHERE credibility_tier = 5 OR credibility_tier IS NULL ORDER BY handle').all();

    // Filter to those appearing in claims if possible
    const inClaims = sources.filter(s => sourcesInClaims.includes(s.handle));
    const display = inClaims.length > 0 ? inClaims : sources;

    summary[key] = {
      count: display.length,
      handles: display.slice(0, 20).map(s => ({
        handle: s.handle,
        tier_label: s.tier_label ?? `Tier ${tier}`,
        political_lean: s.political_lean ?? null,
        ng_score: s.ng_score ?? null,
        tier_confidence: s.tier_confidence ?? null,
        ng_assessed_by: s.ng_assessed_by ?? null,
        entry_count: s.behavior_entry_count ?? 0,
        citation_rate: s.behavior_citation_rate ?? null,
      })),
    };
  }

  return summary;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const topicConfig = TOPICS[TOPIC_ID];
  if (!topicConfig) {
    log(`ERROR: topic '${TOPIC_ID}' not found`);
    process.exit(1);
  }

  const totalClaims = db.prepare('SELECT COUNT(*) c FROM claims WHERE topic = ?').get(TOPIC_ID).c;
  const sources = db.prepare(
    'SELECT COUNT(DISTINCT source_handle) c FROM claims WHERE topic = ? AND source_handle IS NOT NULL'
  ).get(TOPIC_ID).c;

  log(`Building export: ${totalClaims} claims, ${sources} sources`);

  // ── Categories ──────────────────────────────────────────────────────────
  const categories = {};

  for (const catId of CATEGORY_ORDER) {
    const label = CATEGORY_LABELS[catId] || catId;
    const claims = db.prepare(`
      SELECT
        c.id, c.claim_text, c.stance, c.axis_id,
        c.source_handle, c.source_url,
        c.source_tier, c.source_tier_label, c.source_ng_score, c.source_lean,
        s.tier_confidence AS source_tier_confidence,
        s.ng_assessed_by  AS source_ng_assessed_by,
        c.corroborating_count, c.contradicting_count,
        c.status, c.observed_at
      FROM claims c
      LEFT JOIN sources s ON s.handle = c.source_handle
      WHERE c.topic = ? AND c.category = ?
      ORDER BY
        COALESCE(c.source_tier, 5) ASC,
        c.corroborating_count DESC,
        c.observed_at DESC
      LIMIT ${MAX_PER_CATEGORY}
    `).all(TOPIC_ID, catId);

    categories[catId] = {
      label,
      claim_count: db.prepare(
        'SELECT COUNT(*) c FROM claims WHERE topic = ? AND category = ?'
      ).get(TOPIC_ID, catId).c,
      claims: claims.map(c => ({
        id: c.id,
        claim_text: c.claim_text,
        stance: c.stance,
        axis_id: c.axis_id,
        source_handle: c.source_handle,
        source_url: c.source_url,
        source_tier: c.source_tier,
        source_tier_label: c.source_tier_label,
        source_ng_score: c.source_ng_score,
        source_lean: c.source_lean,
        source_tier_confidence: c.source_tier_confidence,
        source_ng_assessed_by: c.source_ng_assessed_by,
        corroborating_count: c.corroborating_count,
        contradicting_count: c.contradicting_count,
        status: c.status,
        observed_at: c.observed_at,
      })),
    };
  }

  // ── Contradictions ───────────────────────────────────────────────────────
  const contradictions = buildContradictions();
  log(`Contradictions found: ${contradictions.length}`);

  // ── Source summary ───────────────────────────────────────────────────────
  const source_summary = buildSourceSummary();

  // ── Axis scores ──────────────────────────────────────────────────────────
  const axis_scores = getAxisScores(topicConfig);

  // ── Sebastian's take ─────────────────────────────────────────────────────
  const sebastians_take = getSebastiansTake();

  // ── Write output ─────────────────────────────────────────────────────────
  const output = {
    topic: TOPIC_ID,
    topic_label: topicConfig.label,
    generated_at: new Date().toISOString(),
    source_count: sources,
    claim_count: totalClaims,
    categories,
    contradictions,
    source_summary,
    axis_scores,
    sebastians_take,
  };

  fs.writeFileSync(EXPORT_PATH, JSON.stringify(output, null, 2));
  const size = Math.round(fs.statSync(EXPORT_PATH).size / 1024);
  log(`Written ${EXPORT_PATH} (${size}KB)`);

  db.close();
}

main();
