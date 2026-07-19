# Deep Research

`runner/deep_research.js` — a Claude-driven research tool composed from the
agent's existing retrieval tools. All inference (triage, plan, refine, synth)
runs on the Claude terminal via `lib/compose.reason()` (`THINK_BACKEND=claude`),
falling back to the local brain.

## Pipeline

| Stage | What happens |
|---|---|
| 0. TRIAGE | Cheap grounding pass (recall/posts/search), then judge the question: **proceed / reformulate / bail** with a clarifying question. Underspecified questions never get a full pass. A bail's answer resumes the research via the clarification-resume ledger. |
| 1. PLAN | Explicit research plan (approach + tool steps), grounded with today's date + a source-quality rubric. Source-aware planning for market/meta questions. |
| 2. EXECUTE | Runs each planned step against a real tool: `recall`, `posts`, `xsearch` (live X search), `search`, `fetch`, `rugcheck` (Solana token rug/cluster analysis), `trending` (exposes mint so rugcheck chains in refinement). |
| 3. REFINE | Critic rounds close researchable gaps AND maintain the **marks ledger**: unfamiliar terms, claims to verify, tool gaps. Iterative — researches the open questions instead of listing them. |
| 4. RESOLVE | Term credibility lookups + claim verification via the intelligence pipeline (`lib/verify_claim`). Unresolvable info needs are recorded in `state/tool_gaps.json` for capability review. |
| 5. SYNTH | Cited report + structured self-assessment `{confidence_pct, compromised}`. `researchAndPublish` gates publishing on it; the short answer's stated certainty is matched to the calibrated confidence. |

## Tiers

- **Flat** — single-pass plan/execute/refine loop (default for inline X mentions).
- **Deep tree** — hierarchical decomposition engine with parallel branch
  execution under a global concurrency limiter. Gated off the inline X-mention
  path (`X_DEEP_TREE`); Telegram `/dr` takes a depth flag (`deep|flat`).
  Design doc: [deep-research-decomposition.md](deep-research-decomposition.md).

## Entry points

| Trigger | Path |
|---|---|
| X mention with research intent | `scraper/reply.js` → spam-filter exemption → focused research-intent re-check → `deep_research` (`X_AUTO_RESEARCH`) |
| Telegram `/dr <question>` | `runner/telegram_bot.js` |
| Active plan open questions | `runner/plan_research.js` — one question per day, detached from the orchestrator maintenance block; progress in `state/plan_research_state.json` (reset when the active plan changes); a research_sprint plan with no questions gets one report derived from its compulsion/title |

## Delivery formats

Chosen per question (`deep_research` delivery choice):
- **Website report page** — `publish_report` → `web/app/report/…` (also what plan_research publishes)
- **X thread** — `researchToThread` posts findings as a thread, no website report
- **X Article** — `researchToArticle` (long-form, Premium editor via HelmStack); article_series plans deliver this way

Replies to research mentions attach the grounded report/journal link — never a
promised-but-hollow one.
