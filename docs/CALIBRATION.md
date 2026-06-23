# Confidence calibration — findings + plan (grounded on live VM, 2026-06-22)

Separate workstream from the SQLite migration. Do NOT start until the SQLite cutover is confirmed stable.

## The problem
`apply_ontology_delta.js:589`: **`confidence = min(0.98, weightedUniqueSources × 0.025)`** — pure trust-weighted source *count*. Decay (`0.002/day`) only fires on unobserved axes and is negligible.

**Live ontology (VM):** 43 axes, mean conf 0.647. Histogram (.1): `0×8 · 0.1×2 · 0.2×2 · 0.3×1 · 0.7×4 · 0.8×4 · 0.9×6 · ~1.0×16`. **13 axes pinned ≥0.975, 21 ≥0.9**; the 0.4–0.6 mid-range is empty. → near-zero discriminating spread; confidence jumps ~0 → ~0.9+.

**Blast radius (confidence is a live gate):** voice tiers (`voice_filter.js` 0.25/0.50/0.75), vocation trigger (`evaluate_vocation.js` ≥0.65), ponder trigger (`ponder.js` ≥0.72 AND |score|≥0.15), conviction ranking (`convictions.js` conf×|score|). Pinned at 0.98 → all run on `|score|` alone; the certainty dimension carries zero information. Visible symptom: voice almost always "very_strongly."

## Prediction track-record (the would-be ground-truth check)
`state/prediction_log.jsonl`: 68 predictions. Keys: `confidence_pct, deadline_at, resolved_at, resolution_status, resolution_note, top_axes, id, tweet_url, ts`. **Per-prediction confidence IS logged** (instrumentation exists). Resolver = `runner/prediction_resolution.js` (wired into `post_browse.js:218`, daily).

**Outcomes:** 0 correct / 4 wrong / 0 partial · 10 expired · 26 pending · 28 old(pre-field). **Hit-rate 0% (0/4 definite).**

**Diagnosis (read the 4 wrong + expired):** the 0/4 is a **broken predict→resolve pipeline, not a worldview verdict.**
- Predictions are vague + short-horizon ("within days", "public calls", "intensify", "address") — barely scoreable.
- Resolver marks `wrong`/`expired` on **"no evidence found in my own ontology/feed"** — it checks "did I *observe* it," not "did it *happen*." Biased toward wrong; can't tell "didn't happen" from "didn't notice."

## Fix A — agreement-weighted axis confidence  [NEAR-TERM, justified]
Replace the volume-only recompute with:
```
volume    = min(1, weightedUniqueSources / ~30)                 // enough-evidence term
agreement = clamp01( 2 × (majorityPoleWeightFraction − 0.5) )   // 0 at 50/50 (contested), 1 unanimous
confidence = round( 0.90 × volume × agreement, 4 )              // 0.90 ceiling (kills the false 0.98)
```
- `agreement` = **directional consistency, NOT |score|** → confidence independent of lean magnitude (a mild-but-consistent lean can be high-confidence; a 50/50 contested axis is low-confidence and the voice hedges — the desired behavior).
- Localized to recompute block (~576–589); per-pole weighted sums already exist for `score`. Keep existing anti-replication gates (dedup / self-echo / diversity / trust) — they protect `agreement`.
- **Mandatory companion — re-tune the 4 downstream gates.** Confidences drop from ~0.98; the 0.25/0.50/0.75 voice tiers, 0.65 vocation, 0.72 ponder would gate everything out if unchanged. Method: implement → **dry-run the formula on current `ontology.json` (no write)** → read new distribution → set thresholds at quantiles preserving intended behavior frequency.
- Effort: formula LOW, re-tune MED. Risk MED (behavioral shift — observe after).
- Agreement curve (the linear `2(frac−0.5)`) is a tuning knob; a gentler concave curve avoids over-punishing clear-but-not-unanimous majorities.

## Fix B — prediction calibration / track-record  [LONG-TERM, brand-intel enabler]
Blocked on **data quality, not instrumentation** (`confidence_pct` already logged):
1. Predictions must be **specific + falsifiable + externally checkable** (not vague "within days" discourse bets).
2. Resolver must use **external verification** (web search / the verify pipeline), not "did I observe it."
3. Accumulate enough resolved predictions across confidence buckets → calibration curve (Brier / reliability) → optional feedback (isotonic/Platt) into confidence.
Multi-month effort; tie to the brand-intel "track record" ambition. Note: predictions derive from axes (`top_axes` logged), so a working track-record is also the empirical validator of whether Fix A's confidence is calibrated.

## Recommendation / sequencing
1. **Not until SQLite cutover is confirmed stable** (both touch `apply_ontology_delta` / the live pipeline).
2. **Fix A first** — the real near-term fix (13 pinned axes + 0/4 make it urgent). Implement → dry-run distribution → re-tune gates → observe.
3. **Fix B** is a redesign (specific predictions + external resolver) before any calibration build — defer, scope with brand-intel.
4. Don't read 0/4 as "the worldview is wrong" — it's a pipeline defect.
