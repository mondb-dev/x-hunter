'use strict';
/**
 * runner/lib/prediction_skill.js — turns RESOLVED prediction outcomes into signal
 * that improves the FORECASTS themselves (not just confidence honesty, which is
 * prediction_calibration.js's job).
 *
 * Three results-driven mechanisms, all fed back into predictive_prompt.js:
 *   1. EDGE PROFILE — per-axis reliability: predictions grounded in axis X have
 *      resolved correct H% of the time (shrunk toward base rate). Lets generation
 *      prefer topics where Sebastian has demonstrated edge and avoid/deweight
 *      topics where he's been consistently wrong.
 *   2. FAILURE MEMORY — the most recent WRONG/EXPIRED predictions with their
 *      resolution notes, injected so the model sees its own mistakes and the
 *      pattern behind them (robust even at low n — the current regime).
 *   3. ABSTENTION BASIS — the raw material for "don't predict where you have no
 *      edge": when the strongest available signal is a topic with demonstrated
 *      negative/neutral edge (and enough data), the generator may return SKIP.
 *
 * DATA-SPARSITY DISCIPLINE: with ~15 resolved predictions, per-axis n is tiny.
 * Edge labels require MIN_N resolved uses before they claim anything; below that
 * they report 'insufficient' and generation treats the topic neutrally. Failure
 * memory carries the load until more resolves. Nothing here HARD-gates on 1-2
 * data points.
 *
 * Pure JS, no deps. Env: PRED_SKILL_MIN_N (4), PRED_SKILL_SHRINK_K (6), PRED_SKILL_MARGIN (0.10).
 */

const MIN_N    = Number(process.env.PRED_SKILL_MIN_N)    || 4;
const SHRINK_K = Number(process.env.PRED_SKILL_SHRINK_K) || 6;
const MARGIN   = Number(process.env.PRED_SKILL_MARGIN)   || 0.10;

const OUTCOME = { correct: 1, partial: 0.5, wrong: 0 };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * @param {Array} predictions parsed prediction_log entries
 * @returns {{baseRate:number|null, resolved:number, perAxis:Object, recentFailures:Array}}
 */
function computeSkill(predictions) {
  const preds = predictions || [];
  const resolved = preds.filter(p => OUTCOME[p.resolution_status] !== undefined);
  const baseRate = resolved.length ? mean(resolved.map(p => OUTCOME[p.resolution_status])) : null;

  // Per-axis: a resolved prediction contributes its outcome to every axis it used.
  const axisTally = {};
  for (const p of resolved) {
    const o = OUTCOME[p.resolution_status];
    for (const label of (p.top_axes || [])) {
      (axisTally[label] = axisTally[label] || []).push(o);
    }
  }
  const perAxis = {};
  for (const [label, outcomes] of Object.entries(axisTally)) {
    const n = outcomes.length;
    const hitRate = mean(outcomes);
    const shrunk = (n * hitRate + SHRINK_K * (baseRate ?? 0.5)) / (n + SHRINK_K);
    let edge;
    if (n < MIN_N) edge = 'insufficient';
    else if (shrunk >= (baseRate ?? 0) + MARGIN) edge = 'edge';
    else if (shrunk <= (baseRate ?? 1) - MARGIN) edge = 'avoid';
    else edge = 'neutral';
    perAxis[label] = { n, hitRate, shrunk, edge };
  }

  // Failure memory: most recent wrong/expired with notes.
  const recentFailures = preds
    .filter(p => p.resolution_status === 'wrong' || p.resolution_status === 'expired')
    .sort((a, b) => new Date(b.resolved_at || b.ts) - new Date(a.resolved_at || a.ts))
    .slice(0, 5)
    .map(p => ({
      prediction: (p.prediction || '').slice(0, 140),
      status: p.resolution_status,
      note: (p.resolution_note || '').slice(0, 160),
      top_axes: p.top_axes || [],
    }));

  return { baseRate, resolved: resolved.length, perAxis, recentFailures };
}

/** Edge score for an axis label (shrunk hit-rate), for ranking; null if unknown. */
function axisScore(label, skill) {
  const a = skill && skill.perAxis && skill.perAxis[label];
  return a ? a.shrunk : null;
}

/**
 * Re-rank drifting axes by BLENDING drift intensity with demonstrated edge, so
 * generation leans toward topics where he's been right. Axes with no track record
 * keep their drift ordering (neutral). Returns a new sorted array (annotated).
 */
function rankByEdge(driftingAxes, skill) {
  const maxDrift = Math.max(1, ...driftingAxes.map(a => a.drift_count || 0));
  return driftingAxes
    .map(a => {
      const s = axisScore(a.label, skill);
      const driftNorm = (a.drift_count || 0) / maxDrift;               // 0..1
      const edgeNorm = s == null ? 0.5 : s;                            // 0..1 (neutral 0.5 when unknown)
      const rank = 0.6 * driftNorm + 0.4 * edgeNorm;                   // drift still leads; edge tilts it
      return { ...a, edge: skill?.perAxis?.[a.label]?.edge || 'insufficient', edgeScore: s, _rank: rank };
    })
    .sort((a, b) => b._rank - a._rank);
}

/** Prompt section: edge profile + failure memory + abstention licence. */
function skillPromptSection(skill) {
  if (!skill || !skill.resolved) return '';
  const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  const parts = [];

  const edged = Object.entries(skill.perAxis).filter(([, v]) => v.edge === 'edge');
  const avoid = Object.entries(skill.perAxis).filter(([, v]) => v.edge === 'avoid');
  if (edged.length || avoid.length) {
    const lines = [];
    for (const [label, v] of edged) lines.push(`  • EDGE — "${label}": right ${pct(v.shrunk)} (n=${v.n}) — you predict well here`);
    for (const [label, v] of avoid) lines.push(`  • AVOID — "${label}": right ${pct(v.shrunk)} (n=${v.n}) — you have NO edge here; don't predict from it, or state very low confidence`);
    parts.push(`WHERE YOU HAVE PREDICTIVE EDGE (base rate ${pct(skill.baseRate)}):\n${lines.join('\n')}`);
  }

  if (skill.recentFailures.length) {
    const fails = skill.recentFailures
      .map(f => `  • [${f.status}] "${f.prediction}"${f.note ? ` — why: ${f.note}` : ''}`)
      .join('\n');
    parts.push(`YOUR RECENT MISSES — learn the failure pattern and don't repeat it:\n${fails}`);
  }

  parts.push(
    `ABSTAIN when warranted: you are NOT required to predict. If the strongest current signal is a topic where you have no demonstrated edge, or the pattern is too weak/noisy to beat chance, return {"abstain": true, "reason": "..."} instead of forcing a low-quality prediction. A skipped prediction is better than a wrong one.`
  );

  return parts.join('\n\n');
}

module.exports = { computeSkill, rankByEdge, axisScore, skillPromptSection };
