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

## Model routing (2026-09-20)

Everything used to run on one model regardless of what the call was doing.
`runner/lib/model_routing.js` routes by call tag, applied in `lib/compose.js`
(the single place every `claude -p` call picks a model; an explicit
`opts.claudeModel` still wins):

| Work | Model | Examples |
|---|---|---|
| Mechanical — classification, scoring, validation, label-picking | **haiku** | `*:factcheck`, `x_reply:coherence`, `llm:content_relevance`, `llm:apply_ontology_delta` (one call per evidence entry), `llm:linkedin_engage`, `dr-pick`, `dr-gap`, `experiment:*:judge` and `:code` |
| Reasoning — the default | **sonnet** | `browse`, `tweet`, `quote`, `reason`, `research_evidence`, `adversarial_eval`, deep-research synthesis |
| Where quality is the product | **opus** | `solution:draft`, `solution:review`, `solution:revise` |

`MODEL_ROUTING=off` disables routing; `CLAUDE_CHEAP_MODEL` / `CLAUDE_QUALITY_MODEL`
override the aliases.

**On the subscription this saves quota, not dollars.** Usage limits are
consumption-weighted, so moving the high-volume mechanical calls off the
reasoning model is what keeps the foundation phase (3 research passes/day on top
of every browse cycle) from exhausting the plan. Two corrections to the estimate
made before the subscription was restored: the Batch API's 50% discount **does
not apply** — `claude -p` is a CLI subprocess with no batch endpoint behind it —
and prompt caching is worth roughly 10% here at best, because the cycle gap
exceeds the cache TTL.

`cost_meter.normalizeModel` now keys `claude-haiku` / `claude` (sonnet) /
`claude-opus` separately, with matching per-1k rates in `state/cost_config.json`
(Haiku 4.5 $1/$5, Sonnet 5 $2/$10, Opus 5 $5/$25 per MTok). Before this, all
three collapsed into one key at one rate, so routed spend was unmeasurable.

## Cycle cadence in the foundation phase

While `lib/agenda_phase.js` reports the foundation phase, `orchestrator.js`
stretches the browse interval to `BROWSE_INTERVAL_FOUNDATION` (default 7200s)
instead of the usual 1800s. The browse cycle is the single largest consumer of
inference, and in that phase it is also the least valuable: feed engagement prep
is already skipped, and the research passes are the work. It snaps back on its
own when the last foundation report lands. A cadence directive still overrides.

Estimated effect on the foundation phase, at the measured call mix: browse drops
from 48 cycles/day to 12, and the mechanical majority of calls moves to a model
that costs a quarter as much per token as sonnet on output.

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
