'use strict';
/**
 * runner/lib/prediction_calibration.js — measures how well Sebastian's STATED
 * prediction confidence matches his ACTUAL hit-rate, and maps a raw stated
 * confidence to a calibrated one.
 *
 * Predictions log a `confidence_pct` (1–100) that was, until now, written and
 * never read — so nothing noticed that at 80%+ stated he was right ~0% of the
 * time (severe, uncorrected overconfidence). This module closes that loop:
 *
 *   computeCalibration(records)  -> reliability table + Brier + overconfidence gap
 *   calibrate(statedPct, model)  -> calibrated pct (empirical, shrunk toward raw)
 *   summaryText(cal)             -> short track-record string for the LLM prompt
 *   refresh(logPath, reportPath) -> recompute from the log + write the JSON report
 *
 * Outcome scoring: correct=1, partial=0.5, wrong=0. `expired`/`pending` and
 * predictions with no numeric confidence are EXCLUDED (no ground truth).
 *
 * Small-sample safety (this is the whole ballgame at n≈15 resolved):
 *   - per-bucket hit-rates are SHRUNK toward the global base rate (SHRINK_K),
 *   - the empirical mapping is BLENDED with the raw estimate by a data-trust
 *     weight min(1, n/TRUST_N) — with little data, calibrated ≈ raw; as
 *     resolutions accumulate it converges to fully empirical,
 *   - buckets are made monotonic (pool-adjacent-violators) so calibration is a
 *     sane non-decreasing curve, not per-bucket noise.
 *
 * Pure JS, no deps. Env knobs: PRED_CAL_SHRINK_K (8), PRED_CAL_TRUST_N (30).
 */

const fs = require('fs');

const SHRINK_K = Number(process.env.PRED_CAL_SHRINK_K) || 8;   // pseudo-counts pulling a bucket toward base rate
const TRUST_N  = Number(process.env.PRED_CAL_TRUST_N)  || 30;  // resolved count for full trust in the empirical map
const BUCKET   = 10;                                           // decile buckets

const OUTCOME = { correct: 1, partial: 0.5, wrong: 0 };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Extract [{stated:0..1, outcome:0/0.5/1}] from resolved, confidence-bearing predictions. */
function toRecords(predictions) {
  const out = [];
  for (const p of predictions || []) {
    if (typeof p.confidence_pct !== 'number') continue;
    const o = OUTCOME[p.resolution_status];
    if (o === undefined) continue; // pending / expired / unknown → no ground truth
    out.push({ stated: clamp(p.confidence_pct / 100, 0.01, 0.99), outcome: o });
  }
  return out;
}

/** Pool-adjacent-violators: smallest non-decreasing fit (isotonic regression). */
function isotonic(values, weights) {
  const v = values.slice(), w = weights.slice();
  let i = 0;
  while (i < v.length - 1) {
    if (v[i] > v[i + 1] + 1e-12) {
      const tw = w[i] + w[i + 1];
      const merged = tw > 0 ? (v[i] * w[i] + v[i + 1] * w[i + 1]) / tw : (v[i] + v[i + 1]) / 2;
      v[i] = merged; w[i] = tw;
      v.splice(i + 1, 1); w.splice(i + 1, 1);
      if (i > 0) i--;              // back up — the merge may have broken the prior pair
    } else i++;
  }
  return { v, w };
}

/**
 * @param {Array} predictions  parsed prediction_log entries
 * @returns full calibration report incl. `model` for calibrate()
 */
function computeCalibration(predictions) {
  const recs = toRecords(predictions);
  const n = recs.length;
  const baseRate = n ? mean(recs.map(r => r.outcome)) : null;
  const meanStated = n ? mean(recs.map(r => r.stated)) : null;
  const brierRaw = n ? mean(recs.map(r => (r.stated - r.outcome) ** 2)) : null;

  // Decile buckets with shrinkage toward base rate.
  const rawBuckets = [];
  for (let lo = 0; lo < 100; lo += BUCKET) {
    const inB = recs.filter(r => r.stated * 100 >= lo && r.stated * 100 < lo + BUCKET);
    const nb = inB.length;
    const hit = nb ? mean(inB.map(r => r.outcome)) : null;
    const shrunk = nb ? (nb * hit + SHRINK_K * (baseRate ?? 0.5)) / (nb + SHRINK_K) : null;
    rawBuckets.push({ lo, hi: lo + BUCKET, n: nb, statedMean: nb ? mean(inB.map(r => r.stated)) : null, hitRate: hit, shrunk });
  }

  // Build a monotonic mapping across ALL deciles: empty buckets fall back to the
  // base rate (a flat prior) so isotonic has a value everywhere.
  const mids = rawBuckets.map(b => (b.lo + BUCKET / 2) / 100);
  const filled = rawBuckets.map(b => (b.shrunk != null ? b.shrunk : (baseRate ?? mids[rawBuckets.indexOf(b)])));
  const weights = rawBuckets.map(b => b.n + (b.n ? 0 : 0.001)); // near-zero weight for empty buckets
  // isotonic() may pool buckets; re-expand to per-decile by walking the pooled blocks.
  const iso = isotonicExpand(filled, weights);
  const dataWeight = n ? clamp(n / TRUST_N, 0, 1) : 0;

  const model = { deciles: iso, baseRate, dataWeight, bucket: BUCKET };
  const brierCalibrated = n
    ? mean(recs.map(r => (calibrate(r.stated * 100, model) / 100 - r.outcome) ** 2))
    : null;

  return {
    n, baseRate, meanStated,
    overconfidenceGap: (meanStated != null && baseRate != null) ? meanStated - baseRate : null,
    brierRaw, brierCalibrated,
    buckets: rawBuckets.filter(b => b.n > 0),
    model,
    generated_at: new Date().toISOString(),
  };
}

/** Run isotonic on values/weights but return a per-index array (pooled blocks expanded back). */
function isotonicExpand(values, weights) {
  // Track block sizes so we can expand the pooled means back to per-decile length.
  let blocks = values.map((val, i) => ({ val, w: weights[i], size: 1 }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].val > blocks[i + 1].val + 1e-12) {
      const a = blocks[i], b = blocks[i + 1];
      const tw = a.w + b.w;
      blocks[i] = { val: tw > 0 ? (a.val * a.w + b.val * b.w) / tw : (a.val + b.val) / 2, w: tw, size: a.size + b.size };
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  const out = [];
  for (const blk of blocks) for (let k = 0; k < blk.size; k++) out.push(blk.val);
  return out;
}

/**
 * Map a raw stated confidence (1–100) to a calibrated one. Uses the isotonic
 * per-decile empirical estimate, blended with the raw value by data-trust weight
 * (little data → stay near raw; lots → trust the empirical curve). Returns 1–99.
 */
function calibrate(statedPct, model) {
  const raw = clamp(Number(statedPct) / 100, 0.01, 0.99);
  if (!model || !model.deciles || model.dataWeight === 0) return Math.round(raw * 100);
  const idx = clamp(Math.floor((raw * 100) / (model.bucket || BUCKET)), 0, model.deciles.length - 1);
  const empirical = model.deciles[idx] != null ? model.deciles[idx] : (model.baseRate ?? raw);
  const cal = model.dataWeight * empirical + (1 - model.dataWeight) * raw;
  return Math.round(clamp(cal, 0.01, 0.99) * 100);
}

/** One-paragraph track record for injecting into the generation prompt. */
function summaryText(cal) {
  if (!cal || !cal.n) return '';
  const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  const lines = cal.buckets
    .map(b => `  • stated ${b.lo}-${b.hi}%: actually right ${pct(b.hitRate)} (n=${b.n})`)
    .join('\n');
  const dir = cal.overconfidenceGap > 0.05 ? 'OVERCONFIDENT' : cal.overconfidenceGap < -0.05 ? 'underconfident' : 'roughly calibrated';
  return `YOUR PREDICTION TRACK RECORD (${cal.n} resolved): you have been ${dir}. ` +
    `Average stated confidence ${pct(cal.meanStated)} vs actual hit-rate ${pct(cal.baseRate)} ` +
    `(gap ${cal.overconfidenceGap > 0 ? '+' : ''}${Math.round((cal.overconfidenceGap || 0) * 100)} pts). By confidence band:\n${lines}\n` +
    `Calibrate accordingly: your honest probability should reflect this record, not optimism.`;
}

/** Recompute from the JSONL log and write the JSON report. Returns the report. */
function refresh(logPath, reportPath) {
  let predictions = [];
  try {
    predictions = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  const cal = computeCalibration(predictions);
  if (reportPath) {
    try { fs.writeFileSync(reportPath, JSON.stringify(cal, null, 2), 'utf-8'); } catch {}
  }
  return cal;
}

module.exports = { computeCalibration, calibrate, summaryText, refresh, toRecords, isotonic };
