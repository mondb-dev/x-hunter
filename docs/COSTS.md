# Operating-Cost Self-Model

Sebastian meters what he costs to run and reasons about it honestly (the basis
for funding discovery; token schemes are hard-prohibited).

## LLM meter (`runner/lib/cost_meter.js`)

One line per LLM call appended to `state/cost_ledger.jsonl` (append-only so
separate processes don't race). Cost estimated from token counts × per-model
prices in `state/cost_config.json`; approximates from text length (~4
chars/token) when counts are unknown. `record()` never throws into a caller.
`rollup({days})` → `{usd, calls, dailyAvgUsd, byModel, byTag}`.

Untagged calls are tagged `llm:<calling file>` (`runner/llm.js callerTag()`).
Before that everything routed through `llm.generate()` shared one bare `llm`
tag, which is how a single job hid ~85–90% of all inference for months.

### Where inference actually went (measured 2026-08-30 → 09-06)

| Bucket | Calls/day | Share |
|---|---|---|
| `intelligence/generate_conflict_claims.js` | ~1,300–2,100 | **~85–90%** |
| Other untagged (relevance scoring, voice filter, stance checks) | ~150–250 | ~10% |
| Everything tagged (browse, tweets, quotes, replies, deep research, planning) | ~116 | ~6% |

The conflict-claims job rebuilt its hardcoded Iran/US/Israel table daily with one
Claude subprocess per claim, re-labelling the same claims every run, to serve one
website page. It is **skipped while a research agenda is active**
(`runner/lib/daily.js`; `INTEL_CONFLICT_CLAIMS=1` forces it back on), and labels are now
cached by claim text (`state/conflict_claims_label_cache.json`) so a rerun only
pays for new claims. Precedent: `collect.js` Phase 5c enrichment was cut the same
way (9,262 calls / $24.62 in one month, 69% of the untagged bucket).

**Budget principle:** inference should go to what produces a final output. A
solution brief — the agenda's product — costs one deep-research pass (~20–40
sonnet calls) plus 2–6 `CLAUDE_SOLUTION_MODEL` (opus) calls to draft, red-team
and revise: roughly 60× less than the job that was cut, spent on the thing that
ships.

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
