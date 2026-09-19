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
| RSS inputs | `scraper/rss_collect.js` `activeFeeds()` | 20 AI feeds added (Alignment Forum, LessWrong curated, arXiv safety query, DeepMind safety, OpenAI, METR, Redwood, Epoch, CAIS, Import AI, Transformer, Zvi, AI Impacts; policy: EU AI Act, CSET, AI Policy Perspectives; plus skeptics: AI Snake Oil, Gary Marcus, Understanding AI). Default news/PH feeds paused except `keep_feeds`. Agenda items are queued for reading first. |
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

Five tracks. Each has **foundation** questions (evidence), **solution** questions (the output),
search terms, source pages, and a seeded axis.

**The foundation phase runs first.** `orderedQuestions()` emits every foundation
(round-robin across tracks) before any solution: 15 foundation days, then 11 solution
days — 26 questions ≈ 26 days at one per day. This is an operator decision (2026-09-19):
the seeded axes start at zero evidence, and a brief written on day 2 would stand on
almost nothing. To go back to interleaving (a track's solutions as soon as its own
foundations are done), swap the two outer loops in `orderedQuestions()`.

The foundation phase grounds the axes as well as the briefs. A finished research
pass now files belief evidence through `runner/lib/research_evidence.js` (see
**Research as evidence** below), so a day spent reading primary sources moves the
ontology instead of only producing a page. The browse/reading loop over the agenda's
feeds and source pages runs alongside it and contributes the rest.

| Track | Foundations | Solutions (examples) |
|---|---|---|
| **Lab accountability** | how safety frameworks changed; third-party evals in system cards | a mechanism that makes lab commitments verifiable; a minimum release-disclosure standard for deployers |
| **Literature** | CoT-monitoring reliability; alignment-faking evidence | a practical monitoring setup for LLM-agent deployers; deployable sycophancy mitigations |
| **Forecasting** | METR task horizons; benchmark saturation | leading indicators that capability is outgrowing oversight; a decision rule for how much autonomy to grant an agent |
| **Self-study** | LLM calibration vs his own record; failure modes of long-running agents; which self-checks actually improve reliability | fix his 79%-stated / 29%-actual calibration; capture-resistant belief formation; safeguards that would have caught his two-month silent failure |
| **Policy & governance** | what the EU AI Act actually requires and who enforces it; what powers the AI safety institutes hold; which instruments outside the EU bind rather than advise | the enforcement/verification mechanism with the best evidence behind it; a minimum control set for a mid-size deployer across the EU AI Act and NIST AI RMF |

Self-study solutions are the ones that can actually be **tested**, on Sebastian himself. Each
brief carries a `self_test` field saying how. Running those tests is an operator decision
(it's a code change), and the result goes back into the ledger.

Seeded axes (left = −1, right = +1; the score is where observed evidence falls, not a preset):
`axis_ai_lab_commitments_v1`, `axis_alignment_tractability_v1`, `axis_safety_verification_v1`,
`axis_ai_progress_pace_v1`, `axis_ai_oversight_model_v1`, `axis_ai_policy_efficacy_v1`,
`axis_agent_self_reliability_v1`.

Integrity rules are injected with the lens. The main ones: no lab is exempt, **including
Anthropic, whose model Sebastian runs on** (disclose the dependency); separate demonstrated results
from claims; steelman every camp; cite primary sources; never publish misuse-relevant
operational detail.

**Caveat carried over from the ontology assessment:** axis scores measure the composition of
what was read. The feed list is deliberately balanced across camps. Keep it that way when
editing, or the new axes will be captured the same way the old ones were.

## The initial phase

While foundation questions remain unanswered, `runner/lib/agenda_phase.js` puts the
runner in research mode — operator decision, 2026-09-19 ("intensive research before
the usual feed"). It reads `agenda.boot`:

| Setting | Default | Effect |
|---|---|---|
| `research_per_day` | 3 | `orchestrator.js` spawns `plan_research.js` every 8h instead of every 24h, so 15 foundation reports take ~5 days, not ~15 |
| `hold_outbound` | true | `x_control.js` suppresses tweets, quotes and reposts (`suppressionReason` → `agenda_foundation_phase`). **Replies are not held** — answering a person who asked something is not broadcasting an ungrounded opinion |
| `pause_feed_engagement` | true | `pre_browse.js` skips comment candidates and the discourse scan/digest. Reading, RSS, browse and evidence filing continue |

It flips to normal operation by itself the moment the last foundation report lands —
nothing to remember, nothing to unset.

Two deliberate properties:

- **Inert until the bootstrap runs.** The policy requires `state/active_plan.json` to
  carry `source: "research_agenda:<id>"`, which only `agenda_bootstrap.js --apply`
  writes. Merging this code cannot silence a system whose pivot was never applied.
  A test asserts this.
- **`AGENDA_BOOT=off`** disables the phase policy while leaving the agenda itself on.

What is NOT paused: the X scraper loop keeps running (it is a separate process and the
browser session depends on it), and the feed still reaches the browse cycle. Under
`full_pivot` browse evidence may only be filed against agenda axes, so feed noise has
nowhere to land anyway.

## Research as evidence

`runner/lib/research_evidence.js` turns a finished research pass into belief evidence.
It runs after every foundation report and after the research pass inside every solution
brief (so it counts even when the brief is later withheld).

```
deep research ─▶ report page
      │
      └─▶ extract ─▶ mechanical validation ─▶ state/ontology_delta_inbox/<ts>-<hash>.json
                                                        │
 browse agent ─▶ state/ontology_delta.json ──────────────┼─▶ apply_ontology_delta.js
                                                        │     (stance check, trust weight,
                                                        │      diversity guard, drift cap)
                                                        └─▶ ontology.json, entries tagged
                                                             with their `writer`
```

The model proposes entries; validation decides. An entry is dropped unless it names an
agenda axis, a pole, a finding of at least 20 characters, and **a URL the research
actually retrieved** — invented sources cannot enter the ontology. At most 2 entries per
axis and 8 per pass; `RESEARCH_EVIDENCE=off` disables filing, `RESEARCH_EVIDENCE_MAX`
changes the cap.

An entry records *what a source shows*, not what Sebastian concludes — the same contract
as browse evidence, and the reason the public export calls the score
`observed_pole_balance`. What changes is the source mix: research evidence comes from
primary sources the agent actually fetched, not from whatever the feed happened to carry.

**Why an inbox rather than the existing file:** `state/ontology_delta.json` belongs to
the browse agent and `apply_ontology_delta.js` deletes it after applying, so a second
writer to that path is silently clobbered. Every pending delta is now drained in one
pass, and each evidence entry carries `writer` (`deep_research`, `solution_brief`, or
absent for browse) into its `evidence_log` entry. Inbox files may not create axes — only
the browse agent may.

## Axes anchor; the knowledge base speaks

Operator decision, 2026-09-19. The two roles were conflated and are now separated:

| | Role | Used for |
|---|---|---|
| **Belief axes** | *anchors* — where to look, and where an observation gets filed | curiosity, source selection, follows, evidence filing, drift tracking |
| **Knowledge base** (`runner/lib/knowledge_base.js`) | *substance* — findings from his own research, each with its source, plus the briefs that survived the gate | what he says, what he replies, what he plans |

An axis score is the balance of what he read. Rendering it as "I strongly hold that
X" made the system assert its own reading list — the central finding of the September
ontology assessment, and the reason the public export calls the field
`observed_pole_balance`. Vocation says who he is; the knowledge base says what he has
earned the right to claim; axes say where he is looking.

**Store:** `state/knowledge/findings.jsonl`, append-only. Written by `plan_research.js`
after every research pass (headline finding, research confidence, report URL, and the
cited claims that were grounded enough to file as evidence) and by `solution_brief.js`
for every outcome — published, withheld, no-solution. A withheld brief is knowledge:
it records what did not survive the red-team, so he does not re-propose it as if it had.

**Read by:**

- `prompts/context.js` `formatKnowledge()` → the tweet, quote and browse prompts. The
  axis block above it is now headed *"RESEARCH ANCHORS — where you file observations.
  Directions, NOT positions you hold."*
- `lib/convictions.js` — under an agenda, "What I have established" (findings with
  sources; proposals flagged as proposals; withheld ones flagged as withheld) replaces
  the axis-derived `I {strongly|clearly} hold that <pole>` lines. With
  `RESEARCH_AGENDA=off` the original axis behaviour is untouched.
- `lib/sebastian_respond.js` — X replies and the website chat. The old block quoted
  `current_stance`, which is generated *from* the axis score; under an agenda it is
  gone, replaced by established findings plus anchor labels with no scores.
- `agendaBlock("planning")` — so ponder, deep dive, decision and the sprint planner all
  see what is already known, with the instruction to extend a finding, test a proposal
  or answer something they left open, rather than re-planning what is answered.

Tests assert that no axis score renders as a conviction and that the reply context
carries no `current_stance` while an agenda is active.

When the knowledge base is empty, every surface says so plainly — "nothing yet, the
research is under way" — instead of falling back to a position. That is the honest
state at bootstrap, and it is why the foundation phase holds outbound.

## Later: certifications

Once there is enough grounding, an obvious next step is for Sebastian to take public AI
safety / policy courses through the HelmStack browser and hold the certificates as
externally checkable evidence of what he has actually learned — a better signal than a
self-reported reading list, and a natural self-study artifact.

Not built, and not purely a code question. Before it can be tried:

- **The operator must create every account and handle any identity or payment step.**
  Sebastian's runner may not create accounts or enter credentials.
- **Check each provider's terms.** Some prohibit automated access outright; some require
  a personal attestation that the work is the candidate's own, which an autonomous agent
  cannot honestly make on a human's behalf. A certificate is only worth holding if how it
  was earned can be stated plainly, so the honest framing is "an AI agent completed this
  course", never a person's name on the certificate.
- Free, no-attestation material (course content, public syllabi, open problem sets) is
  reading he can already do today through the normal reading queue — worth pointing the
  agenda's source pages at before any of the above.

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
new plan's sprints on its next daily run. `plan_research.js` then answers one of the 26
seeded questions per day — the 15 foundations first, then the 11 solutions.

**Preseed before you bootstrap.** `plan_research.js` keys its progress to the plan id, so
re-running the bootstrap on a later date installs a new plan and re-answers foundations
already done. And do not hand-edit questions into `state/active_plan.json`: `questionMeta()`
matches the question string against `research_agenda.js`, so a question that exists only in
the plan gets `kind: null` and routes to deep research, never to `solution_brief.js`. Edit
the agenda file.

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

A future contributing agent now has two of the three pieces it needs. The **delta
inbox** exists (`state/ontology_delta_inbox/`, drained by `apply_ontology_delta.js`), and
evidence entries carry **`writer`** attribution. Still missing: attribution on every
*other* kind of assertion (claims, stances, predictions record a source but never an
author), and real locking — `cleanStaleLocks()` is a stub, so concurrent writers to
`ontology.json` itself are still single-writer by assumption.

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
