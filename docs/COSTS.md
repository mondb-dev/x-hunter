# Operating-Cost Self-Model

Sebastian meters what he costs to run and reasons about it honestly (the basis
for funding discovery; token schemes are hard-prohibited).

## LLM meter (`runner/lib/cost_meter.js`)

One line per LLM call appended to `state/cost_ledger.jsonl` (append-only so
separate processes don't race). Cost estimated from token counts × per-model
prices in `state/cost_config.json`; approximates from text length (~4
chars/token) when counts are unknown. `record()` never throws into a caller.
`rollup({days})` → `{usd, calls, dailyAvgUsd, byModel, byTag}`.

## Burn rate (`runner/lib/operating_cost.js`)

Combines three cost surfaces into a monthly burn rate + a reflection summary:
1. **LLM** — metered live, extrapolated from recent daily average
2. **Fixed** — host/domain/Vercel/other from `state/cost_config.json`
3. **Storage** — Arweave archival funded by the SOL wallet; live balance is the
   runway signal

`compute()` writes `state/operating_cost.json`; `summaryText()` feeds the
reflection prompt / journal. All best-effort and non-throwing.

## Public surface

The website About page renders the yearly cost breakdown + SOL tip progress
(`web/lib/readFunding`, `web/components/FundingProgress`). Framing: tips keep
the pipeline running and independent — no token, no speculation.
