# Predictions & Calibration

## Lifecycle

1. **Generate** — predictive prompts (`runner/predictive_prompt.js`) produce
   dated, falsifiable predictions with a stated confidence; a completeness gate
   rejects vague ones. Logged to `state/prediction_log.jsonl`.
2. **Resolve** — `runner/prediction_resolution.js` (self-throttled to once per
   day via stamp file) takes each prediction past its deadline
   (`resolution_status === "pending"`), gathers ontology context accumulated
   since it was made, and assigns: `correct | wrong | partial | expired`.
   Updates the log in place and re-exports `prediction_export.json` (rendered
   at the website's `/predictions` page). Optionally writes
   `state/resolution_tweet_draft.txt` for the best resolution.
3. **Calibrate** — measured hit-rate vs stated confidence (the system was once
   +62 points overconfident) produces a `calibrated_pct` that is fed back into
   generation, so stated confidence converges toward actual accuracy. The same
   calibration idea gates deep-research publishing (certainty of the short
   answer matched to `confidence_pct`).

## Files

| File | Role |
|---|---|
| `state/prediction_log.jsonl` | Append/update log of all predictions |
| `state/prediction_export.json` | Website export (`/predictions`) |
| `runner/prediction_resolution.js` | Daily resolver |
| `runner/predictive_prompt.js` | Generation-side prompt + completeness gate |
