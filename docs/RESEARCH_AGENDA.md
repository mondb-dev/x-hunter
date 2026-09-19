# Research agenda (operator-set focus)

Since 2026-09-15 Sebastian runs under an **operator-set research agenda: Better AI,
well-founded solutions (full pivot)**. The single source of truth is
[`runner/lib/research_agenda.js`](../runner/lib/research_agenda.js).
`capabilities.js` says what he can *do*; the agenda says what to point that at.

**The final outputs are solutions**: proposals that make AI more useful, reliable and
safe, each grounded in evidence, specific enough to adopt, testable, and red-teamed
before publishing. Research (lab accountability, literature, forecasting, self-study)
is the foundation those solutions stand on. It is not the product.

```
 foundations (deep-research reports)             solution briefs (runner/solution_brief.js)
 lab accountability ─┐                           problem → cited evidence → prior approaches
 literature ─────────┼─▶ evidence base ─▶ draft ─▶ mechanism → falsifiable test → risks
 forecasting ────────┤                     │       ▲
 self-study ─────────┘                     ▼       │ revise (≤3 reviews)
                                       red-team ───┘
                                           │
                                  mechanical gate ─▶ report page + state/solutions.jsonl
                                  (withheld briefs are ledgered with the reason)
```

## Why an agenda exists

Without one, Sebastian's focus is fully emergent, and the loop is closed:

```
feed ─▶ browse evidence ─▶ ontology axes ─┬─▶ curiosity (uncertain axes)      ─▶ what he searches
  ▲                                       ├─▶ follows (axis-label affinity)  ─▶ who is in the feed
  │                                       ├─▶ source_selector (strong axes)  ─▶ what he reads
  │                                       ├─▶ ponder/decision (hard axes)    ─▶ what he plans
  └───────────────────────────────────────┴─▶ vocation (top axes)            ─▶ who he says he is
```

Each stage re-derives from the axes, and the axes come from the feed. So the loop kept
reinforcing week-one topics: the 21 founding axes held 88% of all evidence as of
2026-09 (see the Sept ontology assessment). Editing `vocation.md` doesn't help,
because the next checkpoint re-derives it from the same axes. The agenda puts an operator
lever on **every** stage.

## What the agenda changes

| Stage | File | Behavior under `better_ai` (full_pivot) |
|---|---|---|
| RSS inputs | `scraper/rss_collect.js` `activeFeeds()` | 17 AI feeds added (Alignment Forum, LessWrong curated, arXiv safety query, DeepMind safety, OpenAI, METR, Redwood, Epoch, CAIS, Import AI, Transformer, Zvi, AI Impacts, plus skeptics: AI Snake Oil, Gary Marcus, Understanding AI). Default news/PH feeds paused except `keep_feeds`. Agenda items are queued for reading first. |
| Source pages | `runner/source_selector.js` `queueAgendaSource()` | Rotates the agenda's non-RSS pages (Anthropic research/RSP/alignment blog, DeepMind safety, UK AISI, GovAI, Apollo, FAR.AI, CAIS, METR, Epoch, arXiv search) instead of conviction axes. |
| Reading queue | `runner/reading_queue.js` `pickCandidate()` | Emits people's links first, then agenda entries, then the rest; under full_pivot, off-agenda machine entries are never emitted. Static source pages can be re-read once re-queued (`lastMarks`). |
| Curiosity | `runner/curiosity.js` Path 3b | Agenda driver rotates tracks and search terms, anchored on the track's seeded axis. Discourse, agent-hint, and sprint drivers fire only for on-agenda topics. Contradiction/uncertainty/trending are not reached. |
| Browse lens | `runner/single_pass_browse.js` `identityBlock()` / `evidenceAxes()` | Identity comes from the (pinned) vocation plus the agenda lens and integrity rules. Under full_pivot, evidence may only be filed against agenda axes (old axes go stale by design). |
| Public writing | `runner/lib/prompts/context.js` `formatVocation()` | Tweet, quote, thread, and claims prompts all carry the agenda block. |
| Voice + persona | `runner/lib/research_agenda.js` `voice`, `runner/lib/prompts/{tweet,quote,thread}.js`, `runner/voice_filter.js`, `runner/lib/sebastian_respond.js` `buildPersona`, `runner/lib/refine.js` | The agenda's voice block **replaces** the pre-pivot persona (watchdog / narrative analyst, PH-politics framing, Tagalog-by-default) in every outbound prompt and in the voice filter. English by default; Tagalog/Taglish only for PH **and** AI topics. Conviction tier comes from how grounded a draft is (a linked published brief speaks "strongly") instead of pre-pivot axis confidence, which would otherwise pin every post to "lightly" (160 chars, questions only) because agenda axes start at 0. |
| Positions shown | `runner/lib/prompts/context.js` `formatCurrentAxes`/`formatTopAxes`, `runner/lib/convictions.js`, `runner/lib/stances.js` `activeStances` | Only agenda axes are shown to the writing layer; convictions fall back to "positions still forming + the tracks" rather than pre-pivot beliefs; off-agenda open stances (an impeachment trial, a football vote) are filtered out of everything downstream. |
| Engagement filter | `runner/lib/content_relevance.js` | The relevance rubric and keyword vocabulary are the agenda's ("a checkable claim about AI systems, their behaviour or governance"), not "political messaging, media framing, propaganda". |
| Follows | `scraper/follows.js` | Affinity is scored against agenda vocabulary; under full_pivot, zero-affinity accounts are never followed. The operator seed list `runner/data/better_ai_follow_seed.json` is queued first **only when `"approved": true`** (entries with `"verify": true` are skipped). |
| LinkedIn | `runner/lib/linkedin_connect_queries.js` | Agenda `linkedin_queries` replace the PH/disinfo queries. |
| Planning | `ponder.js`, `deep_dive.js`, `decision.js`, `sprint/planner.js` | Agenda planning block injected; off-agenda plans are rejected. Ponder sees only agenda axes and uses an agenda override when they haven't yet reached conviction thresholds. |
| Deep research | `runner/plan_research.js`, `runner/deep_research.js` | One plan question per day. **Foundation** questions become deep-research reports. **Solution** questions go to `solution_brief.js`, built on that track's published foundation reports. Self-study questions get `selfStudyDossier()`: first-party measurements (prediction calibration, ontology concentration, capture alerts, adversarial self-eval, documented incidents) passed as `dossier` context. |
| Solutions | `runner/solution_brief.js` | The final product. It runs a draft, then a red-team, then revisions, then a gate on `CLAUDE_SOLUTION_MODEL` (default opus). The gate is mechanical: every evidence URL must have been retrieved by the research (≥3 items, ≥2 actually read); the test needs a metric, success threshold and falsifier; no fatal and at most 2 major red-team objections can remain (they are shown on the page); confidence is capped at 80%. Output: a report page, a `state/solutions.jsonl` entry (status `proposed` / `withheld` / `no_solution`), and a `[SOLUTION]` browse note so tweets share it. Report URLs count as sprint artifacts. |
| Predictions / stances | `predictive_prompt.js`, `stance_scan.js` | Forecast only from drifting agenda axes. Principled stances must be AI events. |
| Vocation | `runner/evaluate_vocation.js` `pinVocation()` | `state/vocation.json` is pinned to `agenda.vocation` (no LLM re-derivation). Ponder may rephrase the first-person statement. |
| Ontology | `runner/apply_ontology_delta.js` | Seeded agenda axes are never reaped (the reaper would otherwise delete them 48h after creation with zero evidence). |

## The Better-AI agenda

Four tracks. Each has **foundation** questions (evidence), **solution** questions (the output),
search terms, source pages, and a seeded axis. `orderedQuestions()` schedules them as
foundation round → solution round → …, so a track's solutions always follow its foundation work
(17 questions ≈ 17 days).

| Track | Foundations | Solutions (examples) |
|---|---|---|
| **Lab accountability** | how safety frameworks changed; third-party evals in system cards | a mechanism that makes lab commitments verifiable; a minimum release-disclosure standard for deployers |
| **Literature** | CoT-monitoring reliability; alignment-faking evidence | a practical monitoring setup for LLM-agent deployers; deployable sycophancy mitigations |
| **Forecasting** | METR task horizons; benchmark saturation | leading indicators that capability is outgrowing oversight; a decision rule for how much autonomy to grant an agent |
| **Self-study** | LLM calibration vs his own record; failure modes of long-running agents | fix his 79%-stated / 29%-actual calibration; capture-resistant belief formation; safeguards that would have caught his two-month silent failure |

Self-study solutions are the ones that can actually be **tested**, on Sebastian himself. Each
brief carries a `self_test` field saying how. Running those tests is an operator decision
(it's a code change), and the result goes back into the ledger.

Seeded axes (left = −1, right = +1; the score is where observed evidence falls, not a preset):
`axis_ai_lab_commitments_v1`, `axis_alignment_tractability_v1`, `axis_safety_verification_v1`,
`axis_ai_progress_pace_v1`, `axis_ai_oversight_model_v1`, `axis_agent_self_reliability_v1`.

Integrity rules are injected with the lens. The main ones: no lab is exempt, **including
Anthropic, whose model Sebastian runs on** (disclose the dependency); separate demonstrated results
from claims; steelman every camp; cite primary sources; never publish misuse-relevant
operational detail.

**Caveat carried over from the ontology assessment:** axis scores measure the composition of
what was read. The feed list is deliberately balanced across camps. Keep it that way when
editing, or the new axes will be captured the same way the old ones were.

## Operating it

```bash
node runner/agenda_bootstrap.js            # dry run
node runner/agenda_bootstrap.js --apply    # seed axes, install agenda plan, pin vocation
```

The bootstrap also **retires the pre-pivot working context** so the old beat cannot leak into
new prompts: browse notes, digests, drafts, directives, discourse anchors, sprint context and
the last critique are archived under `state/pre_pivot/<timestamp>/` and cleared; open
pre-pivot stances become `retired` (never resolved, so they do not count as right or wrong);
open pre-pivot claims become `archived_pre_pivot`; and the agenda's X bio is staged in
`state/profile.json` as `pending_bio`. **Setting the X bio is manual** — `update_bio.js`
drives the retired CDP browser and self-gates on a status change a pinned vocation never
produces.

The bootstrap is idempotent. It supersedes every other `active` plan (in `action_plans.json` and
`sprints.db`), so the single-active-plan invariant holds. `sprint_manager.js` plans the
new plan's sprints on its next daily run. `plan_research.js` then answers one of the 12
seeded questions per day.

- **Disable**: set `RESEARCH_AGENDA=off` in `.env` and restart in the sleep window. Every consumer
  falls back to emergent behavior. (Vocation stays as last written until the next checkpoint
  re-derives it.)
- **Read the output**: `state/solutions.jsonl` (every brief, including withheld ones and the
  gate failure that stopped them). Published briefs live at `sebastianhunter.fun/report/<id>`.
  To try one outside the plan: `node runner/solution_brief.js "<question>" --dry-run`.
- **Approve follows**: review `runner/data/better_ai_follow_seed.json`, confirm or fix the
  `verify: true` handles, and set `"approved": true`. Follows run at 10/day.
- **Edit the agenda**: change `runner/lib/research_agenda.js`. Tests in
  `runner/tests/run_tests.js` ("Research agenda + periodic gating") guard keyword false
  positives, search-term coverage, seeded-axis shape, and that the seed list ships unapproved.

## Interfacing with it

The public, machine-readable view of all of this is `sebastianhunter.fun/data` —
see [PUBLIC_DATA.md](PUBLIC_DATA.md). It carries the agenda, the solution briefs
(published and withheld, with gate failures), the axes with honest field names and an
`agenda`/`legacy` status, and the prediction record. Internal `state/` files are not an
interface and should not be read as one.

A future contributing agent would additionally need (neither exists yet): a **delta
inbox** — `apply_ontology_delta.js` currently reads one fixed `state/ontology_delta.json`
and deletes it, so a second writer silently clobbers the first — and **per-agent
attribution** on every assertion, since evidence entries record a source but never an
author. `cleanStaleLocks()` is a stub, so the system is single-writer by assumption.

## Inference budget

Spend inference on what feeds a solution. Measured 2026-08-30 → 09-06 (`state/cost_ledger.jsonl`):
a normal day was ~1,500–2,500 Claude calls, and **~85–90% came from one batch job**,
`intelligence/generate_conflict_claims.js`. It re-labelled the same Iran/US/Israel claims every
day, one call per claim. It is now skipped while an agenda is active (`INTEL_CONFLICT_CLAIMS=1`
forces it on, and a label cache makes reruns pay only for new claims). Untagged calls are now
tagged `llm:<calling file>`, so the next hidden bulk caller shows up in the ledger. The saved
budget goes where the output is: one solution brief per research day ≈ one deep-research pass
(~20–40 sonnet calls) plus 3–5 opus calls to draft, red-team and revise.

## Fixed alongside (2026-09-15)

These bugs made the directed-reading half of the loop dead since ~2026-07-05. They had to be
fixed for any steering to work:

- **Periodic steps never ran.** `pre_browse.js` gated curiosity/search_curiosity/cluster_axes
  on `cycle % 12 === 0` and deep_dive_detector on `% 6 === 0`, and `source_selector.js` on
  `% 3 === 0`. They only run on BROWSE cycles, but every such cycle number is a TWEET or QUOTE
  cycle. Now `dueEvery()` (cycles since last run, `state/pre_browse_cadence.json`) and
  `% 3 === 1`.
- **Machine reading-queue entries were never emitted.** `reading_queue.js` required
  `from_user` + `added_cycle`, which `rss_collect`, `search_curiosity` and `source_followup`
  never wrote (about 3,200 unreadable entries). It now accepts `source` + `queued_at`, with a 12h staleness window.
- **Zombie pending items** blocked `source_selector` forever. Pending now requires freshness.
- **`rss_collect` hung** on a timed-out socket until the runner's 2-minute kill. The socket is now
  destroyed on timeout, and the process exits.
