'use strict';

/**
 * runner/intelligence/generate_conflict_claims.js
 *
 * Extracts claims about the iran-us-israel topic from:
 *   - state/ontology.json evidence_log entries
 *   - state/feed_digest.txt (recent feed)
 *   - state/browse_notes.md (recent browse sessions)
 *
 * Pipeline:
 *   1. Extract raw claim candidates
 *   2. Deduplicate within same source (Jaccard > 0.80 on tokens)
 *   3. Categorize (keyword match → LLM fallback for misc)
 *   4. Enrich with source credibility (from sources table)
 *   5. Group cross-source claims by embedding cosine similarity ≥ 0.82
 *   6. Write to intelligence.db (claims + claim_groups)
 *
 * Fixes from v1:
 *   - MAX_LLM_CALLS = 2000 (was 30 — caused 43% misc)
 *   - Clears tables before writing (idempotent re-runs)
 *   - Embedding-based grouping (not Jaccard) → catches more contradictions
 *
 * Usage: node runner/intelligence/generate_conflict_claims.js [--topic iran-us-israel]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../lib/config');
const db = require('./db');
const { matchesTopic, matchCategories } = require('./topics');

let llm;
try { llm = require('../llm'); } catch { llm = null; }

const TOPIC_ID = 'iran-us-israel';
const MAX_LLM_CALLS = 2000;

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'it','its','this','that','these','those','i','we','they','he','she','you',
  'said','says','according','report','reports','sources','source','also',
  'more','new','now','after','before','over','out','up','about','into','than',
]);

function log(msg) {
  console.log(`[claims] ${msg}`);
}

// ── Tokenizer ────────────────────────────────────────────────────────────────
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

// ── Jaccard similarity (within-source dedup only) ────────────────────────────
function jaccard(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  const inter = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

// ── Handle extractor ─────────────────────────────────────────────────────────
function handleFromUrl(url) {
  if (!url) return null;
  const m = url.match(/x\.com\/([^/]+)\/status\//);
  return m ? m[1].toLowerCase() : null;
}

// ── LLM categorization ────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  nuclear: 'Nuclear Program',
  military_action: 'Military Action',
  diplomatic: 'Diplomacy & Negotiations',
  casualties_humanitarian: 'Casualties & Humanitarian',
  proxy_regional: 'Proxy Forces & Regional',
  threats_claims: 'Threats & Claims',
  internal_politics: 'Internal Politics',
  misc: 'Miscellaneous',
};

async function llmCategorize(claimText) {
  if (!llm) return 'misc';
  const prompt = `Categorize this claim about Iran / US / Israel into one of these categories:
nuclear, military_action, diplomatic, casualties_humanitarian, proxy_regional, threats_claims, internal_politics, misc

Claim: "${claimText}"

Reply with only the category name. No explanation.`;
  try {
    const resp = await llm.generate(prompt, { temperature: 0, maxTokens: 20 });
    const cat = resp.trim().toLowerCase().replace(/[^a-z_]/g, '');
    return CATEGORY_LABELS.hasOwnProperty(cat) ? cat : 'misc';
  } catch {
    return 'misc';
  }
}

// ── LLM axis assignment ───────────────────────────────────────────────────────
const AXIS_IDS = [
  'axis_geopolitical_rhetoric_v1',
  'axis_national_sovereignty_v_intl_law_v1',
  'axis_global_power_realignments_v1',
  'axis_religion_politics_war_v1',
];

async function llmAssignAxis(claimText) {
  if (!llm) return null;
  const prompt = `Which single ontology axis is most relevant to this claim?
Axes:
- axis_geopolitical_rhetoric_v1 (hawkish vs diplomatic framing)
- axis_national_sovereignty_v_intl_law_v1 (sovereignty vs international law priority)
- axis_global_power_realignments_v1 (US-led vs multipolarity)
- axis_religion_politics_war_v1 (religion as driver in conflict vs secular politics)

Claim: "${claimText}"

Reply with only the axis ID. If none fit, reply "none".`;
  try {
    const resp = await llm.generate(prompt, { temperature: 0, maxTokens: 30 });
    const axis = resp.trim().replace(/['"]/g, '');
    return AXIS_IDS.includes(axis) ? axis : null;
  } catch {
    return null;
  }
}

// ── Extract claims from ontology evidence ─────────────────────────────────────
function extractFromOntology() {
  const ontology = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf8'));
  const claims = [];

  for (const axis of (ontology.axes || [])) {
    for (const ev of (axis.evidence_log || [])) {
      const content = ev.content || '';
      if (!content || content.length < 30) continue;
      if (!matchesTopic(TOPIC_ID, content)) continue;

      claims.push({
        text: content.slice(0, 500),
        source_url: ev.source || null,
        source_handle: handleFromUrl(ev.source),
        observed_at: ev.timestamp || new Date().toISOString(),
        stance: ev.pole_alignment === 'left' ? 'left' : ev.pole_alignment === 'right' ? 'right' : 'neutral',
        axis_id: axis.id,
        has_supporting_url: /https?:\/\//.test(content) ? 1 : 0,
      });
    }
  }

  log(`Ontology: ${claims.length} topic-relevant evidence entries`);
  return claims;
}

/** Extract claims from a text block (feed_digest, browse_notes) */
function extractFromText(text, label) {
  if (!text || !text.trim()) return [];
  const claims = [];

  // Split on newlines and extract sentences that look like claims
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 50);
  for (const line of lines) {
    if (!matchesTopic(TOPIC_ID, line)) continue;
    // Basic sentence splitting
    const sentences = line.split(/(?<=[.!?])\s+/).filter(s => s.length > 30 && s.length < 400);
    for (const s of sentences) {
      if (!matchesTopic(TOPIC_ID, s)) continue;
      claims.push({
        text: s,
        source_url: null,
        source_handle: null,
        observed_at: new Date().toISOString(),
        stance: 'neutral',
        axis_id: null,
        has_supporting_url: /https?:\/\//.test(s) ? 1 : 0,
      });
    }
  }

  log(`${label}: ${claims.length} relevant lines extracted`);
  return claims;
}

/** Within-source Jaccard deduplication (threshold 0.80) */
function deduplicateWithinSource(claims) {
  const bySource = new Map();
  for (const c of claims) {
    const key = c.source_handle || '__unknown__';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(c);
  }

  const deduped = [];
  for (const [, group] of bySource) {
    const kept = [];
    for (const c of group) {
      const isDup = kept.some(k => jaccard(k.text, c.text) > 0.80);
      if (!isDup) kept.push(c);
    }
    deduped.push(...kept);
  }

  return deduped;
}

/** Batch embed claims using llm.embed(), strip _vec field */
async function batchEmbed(texts, batchSize = 8) {
  if (!llm || !llm.embed) return null;
  const vecs = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    try {
      const results = await Promise.all(batch.map(t => llm.embed(t)));
      vecs.push(...results);
    } catch {
      // Fill with null on error
      vecs.push(...batch.map(() => null));
    }
  }
  return vecs;
}

/** Group claims by cosine similarity ≥ 0.82 */
function groupByCosine(claims, embeddings) {
  const groups = [];
  const assigned = new Set();

  for (let i = 0; i < claims.length; i++) {
    if (assigned.has(i) || !embeddings[i]) continue;
    const group = [i];
    assigned.add(i);

    for (let j = i + 1; j < claims.length; j++) {
      if (assigned.has(j) || !embeddings[j]) continue;
      const sim = llm.cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= 0.82) {
        group.push(j);
        assigned.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

/** Fallback grouping: Jaccard-based (when embeddings unavailable) */
function groupByJaccard(claims) {
  const groups = [];
  const assigned = new Set();

  for (let i = 0; i < claims.length; i++) {
    if (assigned.has(i)) continue;
    const group = [i];
    assigned.add(i);

    for (let j = i + 1; j < claims.length; j++) {
      if (assigned.has(j)) continue;
      if (jaccard(claims[i].text, claims[j].text) >= 0.55) {
        group.push(j);
        assigned.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Clear existing data for idempotent re-runs
  log('Clearing existing claims and groups...');
  db.exec(`DELETE FROM claims WHERE topic = '${TOPIC_ID}'`);
  db.exec(`DELETE FROM claim_groups WHERE topic = '${TOPIC_ID}'`);

  // ── Step 1: Extract ────────────────────────────────────────────────────────
  let allClaims = [];

  allClaims.push(...extractFromOntology());

  // Feed digest
  if (fs.existsSync(config.FEED_DIGEST_PATH)) {
    const feedText = fs.readFileSync(config.FEED_DIGEST_PATH, 'utf8');
    allClaims.push(...extractFromText(feedText, 'feed_digest'));
  }

  // Browse notes
  if (fs.existsSync(config.BROWSE_NOTES_PATH)) {
    const notesText = fs.readFileSync(config.BROWSE_NOTES_PATH, 'utf8');
    allClaims.push(...extractFromText(notesText, 'browse_notes'));
  }

  log(`Total raw candidates: ${allClaims.length}`);

  // ── Step 2: Within-source dedup ───────────────────────────────────────────
  allClaims = deduplicateWithinSource(allClaims);
  log(`After within-source dedup: ${allClaims.length}`);

  // ── Step 3: Categorize ────────────────────────────────────────────────────
  let llmCallsUsed = 0;
  for (const c of allClaims) {
    const keywordCat = matchCategories(TOPIC_ID, c.text);
    if (keywordCat !== 'misc') {
      c.category = keywordCat;
    } else if (llmCallsUsed < MAX_LLM_CALLS) {
      c.category = await llmCategorize(c.text);
      llmCallsUsed++;
    } else {
      c.category = 'misc';
    }

    // Assign axis if not already known
    if (!c.axis_id && llmCallsUsed < MAX_LLM_CALLS) {
      c.axis_id = await llmAssignAxis(c.text);
      llmCallsUsed++;
    }
  }

  log(`Categorized (${llmCallsUsed} LLM calls used)`);

  // ── Step 4: Enrich from sources table ────────────────────────────────────
  const sourceCache = new Map();
  function getSource(handle) {
    if (!handle) return null;
    if (sourceCache.has(handle)) return sourceCache.get(handle);
    const rec = db.prepare('SELECT * FROM sources WHERE handle = ?').get(handle);
    sourceCache.set(handle, rec || null);
    return rec;
  }

  for (const c of allClaims) {
    const src = getSource(c.source_handle);
    c.source_tier         = src?.credibility_tier   ?? null;
    c.source_tier_label   = src?.tier_label         ?? null;
    c.source_ng_score     = src?.ng_score           ?? null;
    c.source_lean         = src?.political_lean     ?? null;
    c.source_tier_confidence = src?.tier_confidence ?? null;
    c.source_ng_assessed_by  = src?.ng_assessed_by  ?? null;
  }

  // ── Step 5: Embed and group ───────────────────────────────────────────────
  log(`Embedding ${allClaims.length} claims for cross-source grouping...`);
  let groups;

  const texts = allClaims.map(c => c.text);
  const embeddings = await batchEmbed(texts);

  if (embeddings && embeddings.some(e => e !== null)) {
    log('Using embedding-based grouping (cosine ≥ 0.82)');
    groups = groupByCosine(allClaims, embeddings);
  } else {
    log('Embeddings unavailable — falling back to Jaccard grouping');
    groups = groupByJaccard(allClaims);
  }

  log(`Formed ${groups.length} groups from ${allClaims.length} claims`);

  // ── Step 6: Write to DB ───────────────────────────────────────────────────
  const now = new Date().toISOString();

  // Assign group corroboration/contradiction counts
  // A group with stances: if any left + any right → contradictions present
  for (const group of groups) {
    const groupClaims = group.map(i => allClaims[i]);
    const stances = new Set(groupClaims.map(c => c.stance));
    const hasConflict = stances.has('left') && stances.has('right');
    for (const c of groupClaims) {
      c.corroborating_count = group.length - 1;
      c.contradicting_count = hasConflict ? groupClaims.filter(o => o.stance !== c.stance).length : 0;
    }
  }

  const insertClaim = db.prepare(`
    INSERT OR REPLACE INTO claims (
      id, topic, category, claim_text, stance, axis_id,
      source_handle, source_url, source_tier, source_tier_label,
      source_ng_score, source_lean,
      has_supporting_url, corroborating_count, contradicting_count,
      status, observed_at, created_at, updated_at
    ) VALUES (
      @id, @topic, @category, @claim_text, @stance, @axis_id,
      @source_handle, @source_url, @source_tier, @source_tier_label,
      @source_ng_score, @source_lean,
      @has_supporting_url, @corroborating_count, @contradicting_count,
      'unverified', @observed_at, @now, @now
    )
  `);

  const insertGroup = db.prepare(`
    INSERT OR REPLACE INTO claim_groups (
      group_id, topic, category, canonical_text, min_tier, claim_ids, created_at, updated_at
    ) VALUES (
      @group_id, @topic, @category, @canonical_text, @min_tier, @claim_ids, @now, @now
    )
  `);

  const writeAll = db.transaction(() => {
    for (const c of allClaims) {
      c.id = crypto.createHash('sha256')
        .update(`${c.source_url || ''}:${c.text.slice(0, 100)}`)
        .digest('hex')
        .slice(0, 16);
      insertClaim.run({ ...c, topic: TOPIC_ID, claim_text: c.text, now });
    }

    // Multi-claim groups only
    let groupsWritten = 0;
    for (const group of groups) {
      if (group.length < 2) continue;
      const groupClaims = group.map(i => allClaims[i]);
      const canonical = groupClaims[0].text;
      const minTier = Math.min(...groupClaims.map(c => c.source_tier ?? 5));
      const catCounts = {};
      for (const c of groupClaims) catCounts[c.category] = (catCounts[c.category] || 0) + 1;
      const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0][0];

      const groupId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      insertGroup.run({
        group_id: groupId,
        topic: TOPIC_ID,
        category: topCat,
        canonical_text: canonical,
        min_tier: minTier,
        claim_ids: JSON.stringify(groupClaims.map(c => c.id)),
        now,
      });
      groupsWritten++;
    }
    log(`Written: ${allClaims.length} claims, ${groupsWritten} multi-claim groups`);
  });

  writeAll();

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = db.prepare('SELECT COUNT(*) c FROM claims WHERE topic = ?').get(TOPIC_ID).c;
  const byCat = db.prepare(
    'SELECT category, COUNT(*) c FROM claims WHERE topic = ? GROUP BY category ORDER BY c DESC'
  ).all(TOPIC_ID);
  log(`Final: ${total} total claims`);
  for (const row of byCat) log(`  ${row.category}: ${row.c}`);

  db.close();
}

main().catch(err => {
  console.error('[claims] FATAL:', err.message);
  process.exit(1);
});
