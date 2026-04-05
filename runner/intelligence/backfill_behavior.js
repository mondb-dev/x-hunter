'use strict';

/**
 * runner/intelligence/backfill_behavior.js
 *
 * Seeds the intelligence sources table from:
 *  1. state/ontology.json — extracts all source handles from evidence_log entries
 *  2. state/source_registry.json — applies ng_* and behavior_* fields
 *
 * Safe to re-run: upserts only, never deletes.
 *
 * Usage: node runner/intelligence/backfill_behavior.js
 */

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const db = require('./db');

const ONTOLOGY_PATH = config.ONTOLOGY_PATH;
const REGISTRY_PATH = path.join(config.STATE_DIR, 'source_registry.json');

function log(msg) {
  console.log(`[backfill] ${msg}`);
}

/** Extract @handle from a tweet URL like https://x.com/handle/status/... */
function handleFromUrl(url) {
  if (!url) return null;
  const m = url.match(/x\.com\/([^/]+)\/status\//);
  return m ? m[1].toLowerCase() : null;
}

/** Compute behavior stats from a list of evidence entries */
function computeBehavior(entries) {
  if (!entries.length) return null;

  const count = entries.length;
  const withUrls = entries.filter(e => {
    const c = (e.content || '');
    return /https?:\/\//.test(c) || e.has_url;
  }).length;

  const stances = new Set(entries.map(e => e.pole_alignment || e.stance).filter(Boolean));
  const novelties = entries.map(e => e.novelty || e.stance_confidence || 0).filter(n => n > 0);
  const noveltyAvg = novelties.length ? novelties.reduce((a, b) => a + b, 0) / novelties.length : 0;

  // Rough axis spread: count distinct axes referenced
  const axes = new Set(entries.map(e => e.axis_id).filter(Boolean));

  return {
    behavior_entry_count: count,
    behavior_citation_rate: count > 0 ? Math.round((withUrls / count) * 1000) / 1000 : 0,
    behavior_stance_diversity: count > 0 ? Math.round((stances.size / count) * 1000) / 1000 : 0,
    behavior_novelty_avg: Math.round(noveltyAvg * 1000) / 1000,
    behavior_axis_spread: axes.size,
    behavior_computed_at: new Date().toISOString(),
  };
}

function main() {
  const now = new Date().toISOString();

  // ── 1. Load ontology ──────────────────────────────────────────────────────
  if (!fs.existsSync(ONTOLOGY_PATH)) {
    log('ERROR: ontology.json not found');
    process.exit(1);
  }
  const ontology = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, 'utf8'));
  const axes = ontology.axes || [];

  // Build map: handle → { entries[], first_seen, last_seen, axis_ids }
  const handleMap = new Map();

  for (const axis of axes) {
    for (const ev of (axis.evidence_log || [])) {
      const handle = handleFromUrl(ev.source);
      if (!handle) continue;

      if (!handleMap.has(handle)) {
        handleMap.set(handle, {
          entries: [],
          first_seen: ev.timestamp,
          last_seen: ev.timestamp,
          axis_ids: new Set(),
        });
      }
      const rec = handleMap.get(handle);
      rec.entries.push({ ...ev, axis_id: axis.id });
      rec.axis_ids.add(axis.id);
      if (ev.timestamp < rec.first_seen) rec.first_seen = ev.timestamp;
      if (ev.timestamp > rec.last_seen) rec.last_seen = ev.timestamp;
    }
  }

  log(`Loaded ontology: ${handleMap.size} unique handles from evidence`);

  // ── 2. Load source_registry ───────────────────────────────────────────────
  let registry = {};
  if (fs.existsSync(REGISTRY_PATH)) {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    log(`Loaded registry: ${Object.keys(registry).length} classified accounts`);
  } else {
    log('WARN: source_registry.json not found — skipping registry seed');
  }

  // ── 3. Upsert handles from ontology ─────────────────────────────────────
  const upsert = db.prepare(`
    INSERT INTO sources (
      handle, behavior_entry_count, behavior_citation_rate,
      behavior_stance_diversity, behavior_novelty_avg, behavior_axis_spread,
      behavior_computed_at, first_seen, last_seen, created_at, updated_at
    ) VALUES (
      @handle, @behavior_entry_count, @behavior_citation_rate,
      @behavior_stance_diversity, @behavior_novelty_avg, @behavior_axis_spread,
      @behavior_computed_at, @first_seen, @last_seen, @now, @now
    )
    ON CONFLICT(handle) DO UPDATE SET
      behavior_entry_count   = excluded.behavior_entry_count,
      behavior_citation_rate = excluded.behavior_citation_rate,
      behavior_stance_diversity = excluded.behavior_stance_diversity,
      behavior_novelty_avg   = excluded.behavior_novelty_avg,
      behavior_axis_spread   = excluded.behavior_axis_spread,
      behavior_computed_at   = excluded.behavior_computed_at,
      first_seen             = MIN(sources.first_seen, excluded.first_seen),
      last_seen              = MAX(sources.last_seen, excluded.last_seen),
      updated_at             = excluded.updated_at
  `);

  const batchUpsert = db.transaction((entries) => {
    for (const e of entries) upsert.run(e);
  });

  const rows = [];
  for (const [handle, rec] of handleMap) {
    const beh = computeBehavior(rec.entries);
    rows.push({
      handle,
      ...beh,
      first_seen: rec.first_seen,
      last_seen: rec.last_seen,
      now,
    });
  }

  batchUpsert(rows);
  log(`Upserted ${rows.length} handles from ontology`);

  // ── 4. Upsert registry-only accounts + apply ng_* fields ─────────────────
  const upsertRegistry = db.prepare(`
    INSERT INTO sources (
      handle,
      credibility_tier, tier_label, tier_confidence, tier_notes, political_lean, domain,
      ng_no_false_content, ng_responsible_info, ng_corrects_errors,
      ng_news_vs_opinion, ng_no_deceptive_framing,
      ng_score, ng_assessed_by, ng_assessed_at, ng_criteria_notes,
      behavior_entry_count, behavior_citation_rate, behavior_stance_diversity,
      behavior_novelty_avg, behavior_axis_spread, behavior_computed_at,
      created_at, updated_at
    ) VALUES (
      @handle,
      @credibility_tier, @tier_label, @tier_confidence, @tier_notes, @political_lean, @domain,
      @ng_no_false_content, @ng_responsible_info, @ng_corrects_errors,
      @ng_news_vs_opinion, @ng_no_deceptive_framing,
      @ng_score, @ng_assessed_by, @ng_assessed_at, @ng_criteria_notes,
      @behavior_entry_count, @behavior_citation_rate, @behavior_stance_diversity,
      @behavior_novelty_avg, @behavior_axis_spread, @behavior_computed_at,
      @now, @now
    )
    ON CONFLICT(handle) DO UPDATE SET
      credibility_tier  = COALESCE(excluded.credibility_tier, sources.credibility_tier),
      tier_label        = COALESCE(excluded.tier_label, sources.tier_label),
      tier_confidence   = COALESCE(excluded.tier_confidence, sources.tier_confidence),
      tier_notes        = COALESCE(excluded.tier_notes, sources.tier_notes),
      political_lean    = COALESCE(excluded.political_lean, sources.political_lean),
      domain            = COALESCE(excluded.domain, sources.domain),
      ng_no_false_content     = COALESCE(excluded.ng_no_false_content, sources.ng_no_false_content),
      ng_responsible_info     = COALESCE(excluded.ng_responsible_info, sources.ng_responsible_info),
      ng_corrects_errors      = COALESCE(excluded.ng_corrects_errors, sources.ng_corrects_errors),
      ng_news_vs_opinion      = COALESCE(excluded.ng_news_vs_opinion, sources.ng_news_vs_opinion),
      ng_no_deceptive_framing = COALESCE(excluded.ng_no_deceptive_framing, sources.ng_no_deceptive_framing),
      ng_score          = COALESCE(excluded.ng_score, sources.ng_score),
      ng_assessed_by    = COALESCE(excluded.ng_assessed_by, sources.ng_assessed_by),
      ng_assessed_at    = COALESCE(excluded.ng_assessed_at, sources.ng_assessed_at),
      ng_criteria_notes = COALESCE(excluded.ng_criteria_notes, sources.ng_criteria_notes),
      behavior_entry_count      = CASE WHEN excluded.behavior_entry_count > 0
                                    THEN excluded.behavior_entry_count
                                    ELSE sources.behavior_entry_count END,
      behavior_citation_rate    = COALESCE(excluded.behavior_citation_rate, sources.behavior_citation_rate),
      behavior_stance_diversity = COALESCE(excluded.behavior_stance_diversity, sources.behavior_stance_diversity),
      behavior_novelty_avg      = COALESCE(excluded.behavior_novelty_avg, sources.behavior_novelty_avg),
      behavior_axis_spread      = COALESCE(excluded.behavior_axis_spread, sources.behavior_axis_spread),
      behavior_computed_at      = COALESCE(excluded.behavior_computed_at, sources.behavior_computed_at),
      updated_at = excluded.updated_at
  `);

  const batchRegistry = db.transaction((entries) => {
    for (const e of entries) upsertRegistry.run(e);
  });

  let registryCount = 0;
  const regRows = [];
  for (const [handle, rec] of Object.entries(registry)) {
    regRows.push({
      handle,
      credibility_tier:  rec.credibility_tier   ?? null,
      tier_label:        rec.tier_label          ?? null,
      tier_confidence:   rec.tier_confidence     ?? null,
      tier_notes:        rec.tier_notes          ?? null,
      political_lean:    rec.political_lean       ?? null,
      domain:            rec.domain              ?? null,
      ng_no_false_content:     rec.ng_no_false_content     ?? null,
      ng_responsible_info:     rec.ng_responsible_info     ?? null,
      ng_corrects_errors:      rec.ng_corrects_errors      ?? null,
      ng_news_vs_opinion:      rec.ng_news_vs_opinion      ?? null,
      ng_no_deceptive_framing: rec.ng_no_deceptive_framing ?? null,
      ng_score:          rec.ng_score            ?? null,
      ng_assessed_by:    rec.ng_assessed_by       ?? null,
      ng_assessed_at:    rec.ng_assessed_at       ?? null,
      ng_criteria_notes: rec.ng_criteria_notes    ?? null,
      behavior_entry_count:      rec.behavior_entry_count      ?? 0,
      behavior_citation_rate:    rec.behavior_citation_rate    ?? null,
      behavior_stance_diversity: rec.behavior_stance_diversity ?? null,
      behavior_novelty_avg:      rec.behavior_novelty_avg      ?? null,
      behavior_axis_spread:      rec.behavior_axis_spread      ?? null,
      behavior_computed_at:      rec.behavior_computed_at      ?? null,
      now,
    });
    registryCount++;
  }

  batchRegistry(regRows);
  log(`Upserted ${registryCount} registry accounts`);

  // ── 5. Summary ────────────────────────────────────────────────────────────
  const total = db.prepare('SELECT COUNT(*) c FROM sources').get().c;
  const classified = db.prepare('SELECT COUNT(*) c FROM sources WHERE credibility_tier IS NOT NULL').get().c;
  log(`Done. sources table: ${total} total, ${classified} classified`);
  db.close();
}

main();
