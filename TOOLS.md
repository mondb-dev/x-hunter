# TOOLS.md — System Reference

How the system runs, what each script does, and what the agent actually touches.
Code-anchored constants, schedules, and the full module map live in
[docs/INVENTORY.md](docs/INVENTORY.md); this file is the working reference.

---

## How sessions run

The system runs on a local macOS machine as launchd agents.

```
run.sh (init: env, checks, scraper, HelmStack readiness) → orchestrator.js (main loop)
```

- **Cycle time**: ~30 min, auto-adjusted 15–60 min by `runner/cadence.js`
- **Cycle types**: BROWSE by default; QUOTE every 3rd; TWEET every 6th
  (`runner/lib/config.js`); posting window 07–23 local
- **Sleep**: `setTimeout`-based, SIGTERM-safe
- **launchd**: `KeepAlive` restart; prefer restarts in the sleep window

Start/stop:
```bash
launchctl kickstart -k gui/$(id -u)/com.sebastian.runner   # restart runner
launchctl list | grep sebastian                            # status
tail -f runner/runner.log                                  # live logs
```

---

## Orchestrator (`runner/orchestrator.js`)

The main loop. Decides cycle type (cadence override → suppression checks →
counters), invokes the agent, runs pre/post hooks, the social pipeline
(LinkedIn + X activity on BROWSE cycles), daily blocks (stance scan, plan
research, amplify triggers, maintenance), git, and sleep.

---

## Key lib modules (`runner/lib/`) — curated

| Module | Purpose |
|---|---|
| `gemini_agent.js` | Agent loop on Ollama (qwen2.5-agent) — legacy filename |
| `compose.js` | Claude CLI composition (`COMPOSE_BACKEND=claude`) + `reason()` think backend |
| `config.js` | Env + paths + cycle constants |
| `pre_browse.js` | 17-step pre-cycle context pipeline |
| `post_browse.js` | Post-cycle: archive, claim tracking, signals, proactive replies |
| `outbox.js` | Channel-agnostic posting queue (`state/outbox.db`) |
| `outbound_gates.js` | Shared voice + fact-check gates for every outbound surface |
| `post_x_helmstack.js` | X posting adapter → helmstack-social engine |
| `linkedin_plan.js` / `linkedin_performance.js` | Plan-first LinkedIn posting; A/B shape controller |
| `belief_calibration.js` | Axis score/confidence math (single source of truth) |
| `amplify_performance.js` | Amplification learn-loop model (source/topic → engagement) |
| `cost_meter.js` / `operating_cost.js` | LLM spend ledger + burn-rate self-model |
| `capabilities.js` | Registry of what Sebastian can actually do (grounds planning) |
| `helmstack.js` | HelmStack client wrapper (HTTP API :7070) |
| `daily.js` | Daily block: report, article, checkpoint, ponder |
| `git.js` | git add/commit/push after every cycle + Vercel hook |
| `verify_claim.js` | Shared claim-verification wrapper (Cloud Run worker) |
| `prompts/` | Prompt builders (browse, tweet, quote, claims, context) |

## Key runner scripts (`runner/`) — curated

| Script | What it does |
|---|---|
| `apply_ontology_delta.js` | Evidence gates + belief update (see ARCHITECTURE.md) |
| `deep_research.js` | Triage → plan → execute → refine → resolve → synth (docs/DEEP_RESEARCH.md) |
| `plan_research.js` | Answers one open plan question per day via deep research |
| `stance_scan.js` | Daily stance formation + resolution (docs/STANCES.md) |
| `prediction_resolution.js` | Auto-resolve expired predictions (docs/PREDICTIONS.md) |
| `x_amplify.js` / `linkedin_amplify.js` / `amplify_measure.js` | Amplification learn-loop |
| `curiosity.js` | Uncertainty-driven research directive (ceiling 0.82); sprint-aware in silent hours |
| `write_article.js` | Long-form articles (plan-first axis selection; X Articles + Moltbook) |
| `generate_checkpoint.js` / `ponder.js` | Checkpoints + conviction-triggered action plans |
| `telegram_bot.js` | Admin bot: `/dr <question>` deep research (deep\|flat), controls |
| `linkedin_collect.js` / `linkedin_engage.js` / `linkedin_connect.js` | LinkedIn feed → digest, engagement, networking (Follow-first cold / Connect warm) |
| `fb_collect.js` | Facebook observation |
| `recall.js` | FTS5 BM25 + semantic memory retrieval |
| `archive.js` | SQLite memory index + Irys/Arweave upload |
| `builder_vertex.js` | Self-modification builder (Gemini via Vertex) |
| `cdp.js`, `post_tweet.js`, `post_quote.js`, … | **Legacy CDP path** — retained as non-helmstack backend + utilities; live posting is HelmStack |

## Scraper (`scraper/`)

Runs independently via `scraper/start.sh` (collect 10 min · reply 30 min ·
follows 3 h).

| File | Purpose |
|---|---|
| `collect.js` | Feed ingestion via HelmStack; mention capture via live search; BigQuery stream |
| `reply.js` | Mention queue: spam filter → thread context → recall → Claude classify+draft → outbound gate → HelmStack reply. Research-intent mentions route to deep_research. 3/run, 5 min gap, 10/day |
| `follows.js` | Follow scoring + HelmStack follow. 3/run, 10/day |
| `rss_collect.js` | RSS feeds (GMA News, PCIJ, …) into the digest |
| `db.js` | SQLite schema: posts, keywords, accounts, memory, embeddings (`state/index.db`) |
| `analytics.js` | RAKE, TF-IDF, Jaccard, burst detection |
| `query.js` | Topic summary extraction |

## Channel engines (`tools/helmstack-social/`)

Standalone package driving X and LinkedIn through HelmStack:
X — CreateTweet/CreateRetweet GraphQL, quotes/replies via API, browser image
upload, X Articles (Premium editor flow); LinkedIn — voyager posting + media
pipeline, UI-driven reshare, comments.

---

## State files (`state/`)

The old exhaustive table drifted; authoritative list = `ls state/` +
docs/INVENTORY.md §6. Highlights: `ontology.json` (axes),
`outbox.db` (posting queue), `index.db` (posts/keywords/accounts/memory/
embeddings), `prediction_log.jsonl`, `cost_ledger.jsonl` + `cost_config.json` +
`operating_cost.json`, `tool_gaps.json`, `plan_research_state.json`,
`cadence.json`, `trust_graph.json`, `posts_log.json`, `arweave_log.json`
(git-tracked rebuild record), `active_plan.json`, `feed_digest.txt`,
`curiosity_directive.txt`.

---

## LLM configuration

| Role | Model | Env |
|---|---|---|
| Agent brain (browse/journal/ontology) | qwen2.5-agent via Ollama | `BROWSE_MODEL`, `OLLAMA_BASE_URL` |
| Scoring / gating / planning | qwen2.5-agent | `LOCAL_CHAT_MODEL` |
| Outbound prose | Claude CLI (`claude -p`) | `COMPOSE_BACKEND=claude`, `CLAUDE_COMPOSE_MODEL`, `CLAUDE_ARTICLE_MODEL` |
| Research reasoning | Claude CLI | `THINK_BACKEND=claude`, `CLAUDE_THINK_MODEL` |
| Embeddings (768-dim) | nomic-embed-text via Ollama | `LOCAL_EMBED_MODEL` |
| Claim verification (Cloud Run) | Gemini 2.5 Flash via Vertex | worker-side |
| Self-mod builder | Claude CLI; Gemini 2.5 Pro Vertex fallback | `BUILDER_BACKEND=claude`, `CLAUDE_BUILDER_MODEL`; fallback `BUILDER_MODEL`, `BUILDER_CREDENTIALS` |

---

## Browser

- **Runtime**: HelmStack (dedicated `hunter-helmstack` profile), HTTP API on
  `:7070` — `HELMSTACK_URL` / `HELMSTACK_AUTH_TOKEN`; launchd agent
  `com.sebastian.hunter-helmstack`
- **Engines**: `tools/helmstack-social` (X + LinkedIn)
- **Dry-run**: `HELMSTACK_DRY_RUN=1` runs everything up to the Post click
- **Legacy**: Chrome CDP `:18801` (`com.sebastian.browser`) — residual
  utilities + `runner/helmstack_bootstrap.js` cookie transplant
- **Feedback**: dogfooding notes go to gitignored `helmstack/notes/`

---

## Solana wallet

- Generate: `node scripts/gen-wallet.js`
- Env: `SOLANA_PUBLIC_KEY`, `SOLANA_PRIVATE_KEY`
- Uses: Arweave (Irys) archival funding; balance doubles as storage runway in
  the operating-cost self-model

---

## Git (automated)

Every cycle, `runner/lib/git.js` runs add/commit/push (journals, state, daily,
checkpoints, articles, ponders, …). Requires `GITHUB_TOKEN`, `GITHUB_REPO`,
`GIT_USER_NAME`, `GIT_USER_EMAIL`. A Vercel deploy hook (`VERCEL_DEPLOY_HOOK`)
triggers website rebuild after push.

---

## Environment variables (`.env`)

See `.env.example` for the authoritative list; grouped highlights:

```
# models
BROWSE_MODEL / META_MODEL / OLLAMA_BASE_URL / OLLAMA_MODEL
LOCAL_CHAT_MODEL / LOCAL_EMBED_MODEL
COMPOSE_BACKEND / CLAUDE_COMPOSE_MODEL / CLAUDE_ARTICLE_MODEL / CLAUDE_COMPOSE_TIMEOUT_MS
THINK_BACKEND / CLAUDE_THINK_MODEL / CLAUDE_THINK_TIMEOUT_MS
BUILDER_BACKEND / CLAUDE_BUILDER_MODEL / CLAUDE_BUILDER_TIMEOUT_MS
BUILDER_MODEL / BUILDER_CREDENTIALS   # Vertex fallback path

# posting + browser
POST_BACKEND=helmstack / HELMSTACK_URL / HELMSTACK_AUTH_TOKEN / OUTBOX_X
TWEET_START / TWEET_END
X_USERNAME / X_PASSWORD / X_EMAIL

# research
X_AUTO_RESEARCH / X_DEEP_TREE

# infra
GITHUB_TOKEN / GITHUB_REPO / GIT_USER_NAME / GIT_USER_EMAIL / VERCEL_DEPLOY_HOOK
SOLANA_PUBLIC_KEY / SOLANA_PRIVATE_KEY / PAYMENT_ADDRESS
TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
VERIFY_WORKER_URL / PUBLISH_WORKER_URL / MEMORY_API_KEY
GOOGLE_APPLICATION_CREDENTIALS / VERTEX_PROJECT_ID / VERTEX_LOCATION
```

---

## Logging

Structured JSON to stdout → `runner/runner.log` (launchd StandardOutPath).
Scraper loops share `scraper/scraper.log`; HelmStack logs to
`runner/hunter-helmstack.log`; Telegram bot to `runner/telegram_bot.log`.

Prefixes (structured `category` field): `[observe]`, `[update]`, `[axis:new]`,
`[post]`, `[vocation]`, `[profile]`, plus per-module tags like `[collect]`,
`[reply]`, `[apply_delta]`, `[amplify]`, `[outbox]`.
