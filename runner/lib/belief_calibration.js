'use strict';
/**
 * runner/lib/belief_calibration.js — the belief-axis formation math, in one place.
 *
 * Single source of truth for how an axis's score + confidence are derived from
 * its evidence_log, shared by apply_ontology_delta.js (live formation) and
 * recalibrate_beliefs.js (one-time migration).
 *
 * Calibration knobs (env-overridable so tuning needs no code edit):
 *   BELIEF_RECENCY_HALFLIFE (100) — score is a recency-weighted mean; the entry
 *     N positions back gets weight 0.5^(N/HALFLIFE). Recent ~HALFLIFE entries
 *     dominate, so axes with thousands of entries keep updating instead of
 *     freezing on the flat all-history mean.
 *   BELIEF_CONF_MAX (0.95) / BELIEF_CONF_K (35) — confidence saturates slowly:
 *     conf = CONF_MAX*(1 - e^(-weightedSources/CONF_K)). Stays informative past
 *     40 sources (the old ×0.025 formula maxed out there). ~45+ sources clear the
 *     0.65 downstream thresholds.
 */

const RECENCY_HALF_LIFE = Number(process.env.BELIEF_RECENCY_HALFLIFE) || 100;
const CONF_MAX = Number(process.env.BELIEF_CONF_MAX) || 0.95;
const CONF_K   = Number(process.env.BELIEF_CONF_K)   || 35;

/**
 * @param {Array} log  axis.evidence_log (objects with pole_alignment/trust_weight/source, or legacy numbers)
 * @returns {{score:number, confidence:number, weightedSources:number}}
 */
function computeAxisScoreConfidence(log) {
  if (!Array.isArray(log) || !log.length) return { score: 0, confidence: 0, weightedSources: 0 };
  const n = log.length;
  let weightedSum = 0, totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const e = log[i];
    const w = typeof e === "object" ? (e.trust_weight ?? 1.0) : 1.0;
    const sign = typeof e === "object" ? (e.pole_alignment === "right" ? 1 : -1) : (e >= 0 ? 1 : -1);
    const ageRank = (n - 1) - i;                       // 0 = most recent entry
    const recency = Math.pow(0.5, ageRank / RECENCY_HALF_LIFE);
    weightedSum += w * recency * sign;
    totalWeight += w * recency;
  }
  const score = totalWeight ? parseFloat((weightedSum / totalWeight).toFixed(4)) : 0;

  // Confidence: distinct-source count (max trust_weight per source) on the curve.
  const sourceWeights = new Map();
  for (const e of log) {
    if (!e || !e.source) continue;
    const w = e.trust_weight ?? 1.0;
    if (!sourceWeights.has(e.source) || sourceWeights.get(e.source) < w) sourceWeights.set(e.source, w);
  }
  const weightedSources = [...sourceWeights.values()].reduce((s, w) => s + w, 0);
  const confidence = parseFloat(Math.min(CONF_MAX, CONF_MAX * (1 - Math.exp(-weightedSources / CONF_K))).toFixed(4));
  return { score, confidence, weightedSources };
}

module.exports = { computeAxisScoreConfidence, RECENCY_HALF_LIFE, CONF_MAX, CONF_K };
