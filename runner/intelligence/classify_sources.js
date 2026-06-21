'use strict';

/**
 * runner/intelligence/classify_sources.js
 *
 * 3-pass classification pipeline:
 *   Pass 1: Heuristic — classify known media/news domains by pattern
 *   Pass 2: LLM — classify accounts with ≥2 behavior entries (requires Vertex AI)
 *   Pass 3: Write remaining unclassified to state/unclassified_queue.json
 *
 * On GCP VM: all 3 passes run fully.
 * Locally (no Vertex): Pass 1 only; Pass 2 skipped with a warning.
 *
 * Usage: node runner/intelligence/classify_sources.js
 */

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const db = require('./db');

let llm;
try { llm = require('../llm'); } catch { llm = null; }

const QUEUE_PATH = path.join(config.STATE_DIR, 'unclassified_queue.json');

function log(msg) {
  console.log(`[classify] ${msg}`);
}

// ── Heuristic tier rules ─────────────────────────────────────────────────────
// Pattern → { credibility_tier, tier_label, political_lean, domain }
const HEURISTIC_RULES = [
  // Tier 1 — wire services / flagship outlets
  { pattern: /^(reuters|ap|apnews|associated_press|bbcworld|bbcnews|bbc|cnn|nytimes|wsj|washingtonpost|theguardian|aljazeera|france24english|dwnews|abcnews|cbsnews|nbcnews|abcpolitics|politico|thehill|axios)$/i,
    tier: 1, label: 'Major wire / flagship', lean: 'center' },
  { pattern: /^(haaretz|timesofisrael|jerusalempost|ynetenglish|ynet)$/i,
    tier: 1, label: 'Major Israeli outlet', lean: 'center' },
  { pattern: /^(iranintl|irnaenglish|pressTV|tasnimnews|mehrnews|farsienglish)$/i,
    tier: 2, label: 'Iranian state / Iranian expat media', lean: 'center-right' },

  // Tier 2 — established with known editorial bias
  { pattern: /^(foxnews|fox_news|realDonaldTrump|breitbart|dailycaller|nypost|theblaze|tuckercarlson)$/i,
    tier: 2, label: 'Right-leaning outlet', lean: 'right' },
  { pattern: /^(theintercept|jacobin|democracynow|truthdig|mondoweiss|electronicintifada)$/i,
    tier: 2, label: 'Left-leaning outlet', lean: 'left' },
  { pattern: /^(spectatorindex|disclosetv|sentdefender|OSINTdefender|OSINTtechnical|inteldoge)$/i,
    tier: 3, label: 'OSINT account', lean: 'center' },

  // Tier 3 — think tanks, analysts
  { pattern: /^(crisisgroup|cfr_org|iiss_org|sipri|atlasintelligence|war_mapper|michaelkofman|aaronmackh|ariktoler)$/i,
    tier: 2, label: 'Policy / research analyst', lean: 'center' },

  // Tier 4 — activist / opinion-heavy
  { pattern: /^(codepink|bdsmovement|standwithus|jewishvoiceforpeace)$/i,
    tier: 4, label: 'Activist / advocacy account', lean: 'left' },

  // Tier 5 — explicitly propagandist
  { pattern: /^(pressTV)$/i,
    tier: 5, label: 'State propaganda outlet', lean: 'far-left' },
];

function heuristicClassify(handle) {
  const h = handle.replace(/^@/, '').toLowerCase();
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(h)) {
      return {
        credibility_tier: rule.tier,
        tier_label: rule.label,
        tier_confidence: 'medium',
        tier_notes: 'heuristic domain pattern',
        political_lean: rule.lean,
      };
    }
  }
  return null;
}

// ── LLM classification prompt ─────────────────────────────────────────────────
function buildLLMPrompt(handle, source) {
  return `Classify the credibility of this X/Twitter account for intelligence analysis.

Account: @${handle}
Behavior entry count: ${source.behavior_entry_count ?? 0}
Citation rate: ${source.behavior_citation_rate ?? 'unknown'}
Stance diversity: ${source.behavior_stance_diversity ?? 'unknown'}
Known domain: ${source.domain ?? 'unknown'}

Classify the account on this 5-tier scale:
1 = Wire service or major flagship outlet (Reuters, AP, BBC, NYT, WSJ)
2 = Established outlet or credible analyst with known editorial stance
3 = OSINT tracker, mid-tier analyst, or niche journalist
4 = Activist, opinion columnist, or inconsistent quality
5 = State propaganda, coordinated inauthentic, or consistently false

Respond with a JSON object ONLY. No preamble. No explanation.
{
  "credibility_tier": <1-5>,
  "tier_label": "<short label>",
  "tier_confidence": "high|medium|low",
  "tier_notes": "<one sentence rationale>",
  "political_lean": "far-left|left|center-left|center|center-right|right|far-right|state-actor|unknown"
}`;
}

function applyUpdate(handle, fields, changedBy) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM sources WHERE handle = ?').get(handle);

  const logChange = db.prepare(`
    INSERT INTO source_registry_log (handle, field_changed, old_value, new_value, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const update = db.transaction(() => {
    const changed = [];
    for (const [field, newVal] of Object.entries(fields)) {
      const oldVal = existing ? (existing[field] ?? null) : null;
      if (String(oldVal) !== String(newVal)) {
        changed.push(field);
        logChange.run(handle, field, String(oldVal), String(newVal), changedBy, now);
      }
    }

    if (existing) {
      const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE sources SET ${sets}, updated_at = @now WHERE handle = @handle`)
        .run({ ...fields, now, handle });
    } else {
      db.prepare(`
        INSERT INTO sources (handle, created_at, updated_at,
          credibility_tier, tier_label, tier_confidence, tier_notes, political_lean)
        VALUES (@handle, @now, @now,
          @credibility_tier, @tier_label, @tier_confidence, @tier_notes, @political_lean)
      `).run({
        handle, now,
        credibility_tier: fields.credibility_tier ?? null,
        tier_label: fields.tier_label ?? null,
        tier_confidence: fields.tier_confidence ?? null,
        tier_notes: fields.tier_notes ?? null,
        political_lean: fields.political_lean ?? null,
      });
    }

    return changed.length;
  });

  return update();
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const unclassified = db.prepare(
    'SELECT * FROM sources WHERE credibility_tier IS NULL ORDER BY behavior_entry_count DESC'
  ).all();

  log(`Unclassified sources: ${unclassified.length}`);

  let heuristicCount = 0;
  let llmCount = 0;
  const remaining = [];

  // Pass 1: Heuristic
  for (const source of unclassified) {
    const result = heuristicClassify(source.handle);
    if (result) {
      applyUpdate(source.handle, result, 'heuristic');
      heuristicCount++;
    } else {
      remaining.push(source);
    }
  }
  log(`Pass 1 (heuristic): classified ${heuristicCount}`);

  // Pass 2: LLM (requires Vertex AI)
  const llmCandidates = remaining.filter(s => (s.behavior_entry_count ?? 0) >= 2);
  log(`Pass 2 (LLM): ${llmCandidates.length} candidates with ≥2 entries`);

  if (!llm) {
    log('WARN: llm module not available — skipping LLM pass');
  } else {
    let llmErrors = 0;
    for (const source of llmCandidates) {
      try {
        const prompt = buildLLMPrompt(source.handle, source);
        const raw = await llm.generate(prompt, { temperature: 0.1, maxTokens: 256 });

        // Parse JSON from response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { llmErrors++; continue; }
        const result = JSON.parse(jsonMatch[0]);

        if (!result.credibility_tier || result.credibility_tier < 1 || result.credibility_tier > 5) {
          llmErrors++; continue;
        }

        applyUpdate(source.handle, {
          credibility_tier:  result.credibility_tier,
          tier_label:        result.tier_label        || `Tier ${result.credibility_tier}`,
          tier_confidence:   result.tier_confidence   || 'medium',
          tier_notes:        result.tier_notes        || '',
          political_lean:    result.political_lean    || 'unknown',
        }, 'llm:gemini');

        llmCount++;
      } catch (err) {
        llmErrors++;
        if (llmErrors <= 3) log(`LLM error for @${source.handle}: ${err.message}`);
      }
    }
    log(`Pass 2 (LLM): classified ${llmCount}, errors: ${llmErrors}`);
  }

  // Pass 3: Write remaining unclassified queue
  const stillUnclassified = db.prepare(
    'SELECT handle, behavior_entry_count FROM sources WHERE credibility_tier IS NULL ORDER BY behavior_entry_count DESC'
  ).all();

  fs.writeFileSync(QUEUE_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    count: stillUnclassified.length,
    handles: stillUnclassified.map(s => s.handle),
  }, null, 2));

  log(`Pass 3: ${stillUnclassified.length} handles written to unclassified_queue.json`);

  const classified = db.prepare('SELECT COUNT(*) c FROM sources WHERE credibility_tier IS NOT NULL').get().c;
  const total = db.prepare('SELECT COUNT(*) c FROM sources').get().c;
  log(`Done. ${classified}/${total} sources classified`);

  db.close();
}

main().catch(err => {
  console.error('[classify] FATAL:', err.message);
  process.exit(1);
});
