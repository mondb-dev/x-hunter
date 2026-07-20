# Codebase Inventory — ground truth as of 2026-07-19

Code-derived snapshot (docs/DOCS_SYNC_PLAN.md Phase 0). Every claim below carries its
source file so future audits are one grep away. When a doc disagrees with this file,
the doc is wrong or the code moved — re-verify here first.

## 1. Entry points & schedules (launchd, local Mac)

| Agent (`~/Library/LaunchAgents`) | Runs | Notes |
|---|---|---|
| `com.sebastian.runner` | `bash runner/run.sh` (KeepAlive) | init → `runner/orchestrator.js` main loop; logs `runner/runner.log` |
| `com.sebastian.browser` | Chrome `--remote-debugging-port=18801` | legacy CDP Chrome — still used by residual CDP posting paths and `helmstack_bootstrap.js` cookie transplant |
| `com.sebastian.hunter-helmstack` | HelmStack app (dedicated `hunter-helmstack` profile) | browser substrate; HTTP API `:7070` (`HELMSTACK_URL`) |
| `com.sebastian.telegram-bot` | `node runner/telegram_bot.js` | admin commands incl. `/dr` deep research |
| `ai.openclaw.x-hunter` | openclaw gateway | **legacy** — run.sh:195 says "openclaw gateway removed"; agent now runs via `runner/lib/gemini_agent.js` directly. Plist still loaded; candidate for disabling. |

Cycle scheduling (`runner/lib/config.js:17-26`, `runner/cadence.js:37-39`):
- `BROWSE_INTERVAL` 1800s default, clamped [900, 3600] (15–60 min) by the cadence
  engine `runner/cadence.js` (metacognition: signal density, axis velocity, post
  pressure, staleness; can also override next cycle type, max 3 consecutive).
- `TWEET_EVERY=6` (tweet cycle every 6th), `QUOTE_OFFSET=3` (quote cycle at the midpoint).
- Posting window `TWEET_START=7` → `TWEET_END=23` local (else downgrade to BROWSE).
- X suppression flags can downgrade TWEET/QUOTE to BROWSE (orchestrator.js:595-612).

Scraper loops (`scraper/start.sh:21-23`): collect 600s · reply 1800s · follows 10800s.

## 2. The three-model split (who thinks vs who writes)

| Role | Model | Where |
|---|---|---|
| Agent brain (browse/journal/ontology) | **qwen2.5-agent** local via Ollama (`BROWSE_MODEL`, `.env`) | `runner/lib/gemini_agent.js` — legacy filename; it's an OpenAI-compatible chat loop on `OLLAMA_BASE_URL` (localhost:11434), Vertex only if that URL points at aiplatform (`gemini_agent.js:18-20`) |
| Scoring / gating / planning | qwen2.5-agent (`LOCAL_CHAT_MODEL`) | `runner/local_llm.js`; `runner/llm.js` routes generate/embed to it when OLLAMA_BASE_URL is local |
| Outbound prose (tweets, quotes, replies, LinkedIn, articles) | **Claude CLI** (`claude -p`, `COMPOSE_BACKEND=claude`) | `runner/lib/compose.js` — full system-prompt override, no tools; local fallback |
| Deep-research reasoning (plan, refine, synth) | **Claude CLI** (`THINK_BACKEND=claude`) | `runner/deep_research.js` header |
| Embeddings (768-dim) | **nomic-embed-text** local (`LOCAL_EMBED_MODEL`) | `runner/local_llm.js:22`; Vertex `text-embedding-004` fallback path retained in `runner/llm.js` |
| Claim verification (worker + local intelligence scripts) | **Gemini 2.5 Flash** via Vertex | `workers/verify/index.js:137` (Cloud Run), `runner/intelligence/verify_claims.js` — genuinely still Gemini |
| Media/vision description | Gemini 2.5 Flash via Vertex | `runner/vision.js:19` (`describeMedia`, used by collect.js) |
| Article covers | **No model** — attributed og:image from a cited/evidence source (Imagen retired 2026-07) | `runner/article_art.js` (reuses `lib/lead_source_image` + `lib/source_image`) |
| Landmark hero art | **Gemini web app** via HelmStack browser session (signed-in Google account, no API key; Imagen retired 2026-07) | `tools/helmstack-social/src/gemini.js` engine ← `runner/landmark/art.js`; video generation scaffolded (needs Veo entitlement on the signed-in account) |
| Self-modification builder | **Claude CLI** (`BUILDER_BACKEND=claude`, `CLAUDE_BUILDER_MODEL`); Gemini 2.5 Pro Vertex fallback (`BUILDER_MODEL`) | `runner/builder_vertex.js` — routes like compose/think; falls back to Vertex on Claude failure |
| Website /api/ask endpoint | Gemini 2.5 Flash via Vertex | `web/lib/sebastianRespond.ts` (server-side site code) |

## 3. Cycle anatomy

**Pre-browse** (`runner/lib/pre_browse.js`, 17 runScript steps): fts_maintain →
topic summary (`scraper/query.js --hours 4`) → memory recall (FTS5+semantic) →
curiosity → search_curiosity → cluster_axes → rss_collect → comment_candidates →
discourse_scan → discourse_digest → external_source_discovery →
external_source_profile → source_selector → reading_queue → deep_dive_detector →
prefetch → source-label classification. (Old "14-step" count is stale.)

**Browse**: `agentRun` (orchestrator.js:17 → gemini_agent) with qwen; writes
`browse_notes.md` + `ontology_delta.json`. Social pipeline (LinkedIn+X activity via
HelmStack) runs on BROWSE cycles (orchestrator.js:185).

**Evidence gates** (`runner/apply_ontology_delta.js`): source validity → per-session
source dedup → self-echo → claim fingerprint (SHA-1, 6h window, :409) → stance
validation (Ollama, min conf 0.50, :69) → diversity constraint (dominant pole >70%
→ weight 0.5; >90% → skip, :57-61) → score recompute via
`runner/lib/belief_calibration.js` → drift cap ±0.05/day (:109) → confidence decay
0.002/day (:632-644).

**Belief math** (`runner/lib/belief_calibration.js` — replaced the old ×0.025/0.98
formula): score = recency-weighted mean, half-life 100 entries
(`BELIEF_RECENCY_HALFLIFE`); confidence = 0.95·(1−e^(−weightedSources/35))
(`BELIEF_CONF_MAX`, `BELIEF_CONF_K`). **Docs/website still citing "0.025 per source,
0.98 ceiling" are wrong.**

**Axis creation** (AGENTS.md:45-53): tension ≥6× in 24h, ≥4 distinct accounts,
≥2 topic clusters, two definable poles, no semantic duplicate.

**Curiosity** (`runner/curiosity.js:50`): confidence ceiling 0.82.

**Scraper collect** (`scraper/collect.js`): sanitize → RAKE → dedup (Jaccard 0.65,
`scraper/analytics.js:136`) → TF-IDF novelty → local-LLM enrichment (post.gemini_meta
field name is legacy; enrichment runs on the local model via `_llmGenerate`) →
burst detection → SQLite insert + inline embedding → permanent local posts archive (`state/posts_archive/YYYY-MM.jsonl`; replaced BigQuery in the GCP exit, 2026-07).
Follows (`scraper/follows.js:18,45`): max 3/run, 10/day, 1 min between.

## 4. Outbound pipeline

- **Outbox queue** `runner/lib/outbox.js` — better-sqlite3 `state/outbox.db`,
  append-only `outbound` table; statuses pending|claimed|posted|rejected|failed|stale;
  LIFO claim (freshest wins); content-hash dedupe (7 days). LinkedIn fully migrated;
  X opt-in via `OUTBOX_X=1` (`runner/lib/post_x_helmstack.js:26-30`).
- **Shared gates** `runner/lib/outbound_gates.js` — every outbound surface passes
  `voice` (voice_filter) + `factcheck` (composes via compose.js → Claude); fact-check
  fails OPEN on LLM error.
- **X engine**: `tools/helmstack-social` package (X + LinkedIn engines);
  `POST_BACKEND=helmstack` (.env:98). Tweets via CreateTweet GraphQL; quotes/replies
  via API; reposts via CreateRetweet; X Articles ported to HelmStack. Adapter:
  `runner/lib/post_x_helmstack.js` (keeps draft/result/attempt file contract).
  Legacy CDP scripts (`runner/post_tweet.js` etc.) remain as the non-helmstack
  backend path; live path is HelmStack.
- **LinkedIn**: plan-first posting (`runner/lib/linkedin_plan.js` — shape assigned by
  A/B controller `linkedin_performance.pickShape`, planner fits material, overrides
  logged); voyager media pipeline for images; UI-driven reshare.
- **Facebook**: engine + observation scaffolding (`runner/lib/fb_sources.js`,
  `fb_figures.js`, `runner/fb_collect.js`); share loop pending (posting-roadmap).
- **Images**: `runner/lib/lead_source_image.js` — auto-trigger source og:image on
  composed tweets/LinkedIn drafts; excludes X URLs; requires page-level coherence.
- **Amplification learn-loop**: `runner/x_amplify.js` (bandit repost trigger,
  1/run, relevance-min 2), `runner/linkedin_amplify.js` (reshare parallel),
  `runner/amplify_measure.js` (score amplifications >24h old, max 8/run),
  `runner/lib/amplify_performance.js` (source/topic → engagement correlation).
- **Moltbook**: `runner/moltbook.js` article cross-post. **Networking**:
  `runner/linkedin_connect.js` + `runner/lib/linkedin_connect_queries.js` (Follow-first for
  cold, Connect for warm), `fb` follow parallel.

## 5. Research / stances / predictions / costs

- **Deep research** `runner/deep_research.js`: TRIAGE (proceed/reformulate/bail) →
  PLAN → EXECUTE (tools: recall, posts, xsearch, search, fetch, rugcheck, trending)
  → REFINE (critic rounds + marks ledger: unfamiliar terms, claims to verify, tool
  gaps → `state/tool_gaps.json`) → RESOLVE (term lookups + verify_claim) → SYNTH
  (cited report + {confidence_pct, compromised} self-assessment; publish gate
  matches stated certainty to calibrated confidence). Delivery: website report page
  (`publish_report`), X thread (`researchToThread`), or X Article
  (`researchToArticle`). Deep-tree tier (hierarchical decomposition, parallel
  branches w/ concurrency limiter) gated off the inline X-mention path; Telegram
  `/dr` has depth flag (deep|flat). Entry points: X mentions (scraper/reply.js),
  Telegram bot, plan-driven daily (`runner/plan_research.js` — one open plan
  question per day, detached, state in `state/plan_research_state.json`).
- **Stances** `runner/stance_scan.js` (daily, detached, `STANCE_SCAN_ENABLED`):
  RESOLVE up to 2 open stances via web search (was_right feeds ontology via
  `lib/stances` → ontology_delta); FORM 0-2 new stances on named, time-bound,
  contested events — principled stances must ground in real axes; taste stances
  capped at 2. Spectrum positions (event-scoped mini-axis), not binary.
- **Predictions** `runner/prediction_resolution.js` (self-throttled 1/day):
  resolves past-deadline predictions → correct|wrong|partial|expired; updates
  `prediction_log.jsonl` + `prediction_export.json`. Calibration
  (`runner/predictive_prompt.js` + belief_calibration feedback) injects measured
  hit-rate back into generation.
- **Daily video** `runner/where_is_sebastian.js` — "Where is Sebastian today?"
  series: inclination-derived scene brief (reason/Claude) → Veo via the Gemini
  web engine; gated on account entitlement; output `state/videos/`, review via
  Telegram.
- **Costs** `runner/lib/cost_meter.js` (per-LLM-call ledger →
  `state/cost_ledger.jsonl`, rollup by model/tag) + `runner/lib/operating_cost.js`
  (LLM + fixed costs from `state/cost_config.json` + SOL-wallet storage runway →
  `state/operating_cost.json`, summary line in reflection prompt). Funding surface
  on website About (`web/lib/readFunding`).

## 6. Data & state

- **SQLite** `state/index.db` (`scraper/db.js`): tables posts (:37), keywords (:73),
  accounts (:84), memory (:100), embeddings (:126). WAL. 7-day rolling window for
  posts; the **local posts archive** (`state/posts_archive/`, append-only NDJSON, monthly files, never pruned) is the permanent store — BigQuery streaming retired 2026-07 (GCP exit).
- **Outbox** `state/outbox.db` (separate better-sqlite3 DB).
- **Key state files**: ontology.json, trust_graph.json, feed_digest.txt,
  curiosity_directive.txt, cadence.json, reading_queue.jsonl,
  external_sources.json, prediction_log.jsonl, cost_ledger.jsonl,
  cost_config.json, operating_cost.json, tool_gaps.json, plan_research_state.json,
  stances (lib/stances registry), posts_log, active_plan.
- **Workers (Cloud Run)**: verify (Gemini claim verification), publish
  (verification export + drafts), **memory** (workers/memory — third worker,
  `MEMORY_API_KEY`).
- **Website**: `web/` Next.js on Vercel; `web/scripts/prebuild.js` copies repo
  content into `web/data/` at build; deploy on push to main (+
  `VERCEL_DEPLOY_HOOK`).

## 7. External surfaces

HelmStack HTTP API `:7070` (`HELMSTACK_URL`/`HELMSTACK_AUTH_TOKEN`) · X GraphQL
(CreateTweet/CreateRetweet) via helmstack-social · LinkedIn voyager + UI drive ·
Ollama localhost:11434 · Vertex AI (workers/verify, builder, fallback paths) ·
Arweave via Irys (Solana-funded; SOLANA_* keys) · Moltbook API
· Telegram bot API · Vercel deploy hook · Cloud Run worker URLs
(VERIFY_WORKER_URL, PUBLISH_WORKER_URL) · GitHub push per cycle.

Env vars in live `.env` (names only): see `.env.example`; notable current ones —
BROWSE_MODEL, META_MODEL, OLLAMA_BASE_URL/OLLAMA_MODEL, LOCAL_CHAT_MODEL,
LOCAL_EMBED_MODEL, COMPOSE_BACKEND, CLAUDE_COMPOSE_MODEL, CLAUDE_ARTICLE_MODEL,
THINK_BACKEND, CLAUDE_THINK_MODEL, BUILDER_BACKEND, CLAUDE_BUILDER_MODEL,
CLAUDE_BUILDER_TIMEOUT_MS, POST_BACKEND=helmstack, HELMSTACK_URL,
HELMSTACK_AUTH_TOKEN, OUTBOX_X, X_AUTO_RESEARCH, X_DEEP_TREE, TWEET_START/END.

## 8. Dead / legacy code flags

- `runner/cdp.js` + CDP consumers (post_tweet/post_quote/post_thread/post_article/
  post_claims_thread/delete_tweet/post_and_pin/inject_cookies/check_notifs) —
  retained as legacy POST_BACKEND path + utilities; live path is HelmStack.
- `ai.openclaw.x-hunter` launchd agent — gateway removed from run.sh flow.
- `runner/lib/gemini_agent.js`, `scraper/embed.js` headers still say
  Gemini/text-embedding-004 — misleading comments, local models in practice.
- `post.gemini_meta` field in scraper — legacy name for local-LLM enrichment.
- Old ×0.025/0.98 confidence formula — superseded by belief_calibration.js
  (recalibrate_beliefs.js was the one-time migration).
