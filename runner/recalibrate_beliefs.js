#!/usr/bin/env node
'use strict';
/**
 * runner/recalibrate_beliefs.js — one-time recalibration of existing belief axes
 * to the new formation math (runner/lib/belief_calibration.js).
 *
 * By default recomputes CONFIDENCE for every axis with the new slow-saturating
 * curve — safe: confidence is a certainty measure, not a stance, so fixing the
 * old ×0.025 saturation (20/43 axes were maxed) changes no positions.
 *
 * SCORE is left alone by default so established axes un-freeze gradually via the
 * ±0.05/day drift cap (in keeping with the slow-belief-change philosophy). Pass
 * --score to also recompute scores now (recency-weighted, bypassing the drift
 * cap) — a harder reset that immediately re-weights toward recent evidence.
 *
 * Flags: --dry (report only), --score (also recompute scores).
 * Writes a timestamped backup before saving.
 */

const fs = require('fs');
const path = require('path');
const { computeAxisScoreConfidence, RECENCY_HALF_LIFE, CONF_MAX, CONF_K } = require('./lib/belief_calibration.js');

const ONTO = path.join(__dirname, '..', 'state', 'ontology.json');
const DRY = process.argv.includes('--dry');
const DO_SCORE = process.argv.includes('--score');

const onto = JSON.parse(fs.readFileSync(ONTO, 'utf-8'));
const axes = onto.axes || [];
console.log(`[recalibrate] ${axes.length} axes | half-life=${RECENCY_HALF_LIFE} conf_max=${CONF_MAX} conf_k=${CONF_K} | mode=${DO_SCORE ? 'confidence+score' : 'confidence-only'}${DRY ? ' (dry)' : ''}`);

const movers = [];
for (const a of axes) {
  const { score, confidence, weightedSources } = computeAxisScoreConfidence(a.evidence_log || []);
  const oldC = a.confidence ?? 0, oldS = a.score ?? 0;
  const row = { id: a.id, n: (a.evidence_log || []).length, src: Math.round(weightedSources), oldC, newC: confidence, oldS, newS: score };
  if (Math.abs(confidence - oldC) >= 0.03 || (DO_SCORE && Math.abs(score - oldS) >= 0.03)) movers.push(row);
  if (!DRY) {
    a.confidence = confidence;
    if (DO_SCORE) a.score = score;
  }
}

movers.sort((x, y) => Math.abs(y.newC - y.oldC) - Math.abs(x.newC - x.oldC));
console.log(`\n[recalibrate] ${movers.length} axis(es) shift by >=0.03:`);
for (const m of movers.slice(0, 25)) {
  const c = `conf ${m.oldC.toFixed(3)}→${m.newC.toFixed(3)}`;
  const s = DO_SCORE ? `  score ${m.oldS.toFixed(3)}→${m.newS.toFixed(3)}` : '';
  console.log(`  ${String(m.n).padStart(5)}ev/${String(m.src).padStart(3)}src  ${c}${s}  ${m.id}`);
}

if (DRY) { console.log('\n[recalibrate] dry run — no changes written'); process.exit(0); }

const backup = ONTO.replace(/\.json$/, `.bak-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(backup, JSON.stringify(onto, null, 2));
onto.last_updated = new Date().toISOString();
fs.writeFileSync(ONTO, JSON.stringify(onto, null, 2));
console.log(`\n[recalibrate] wrote ontology.json (backup: ${path.basename(backup)})`);
