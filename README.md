# Sebastian D. Hunter

A continuous social-listening and directed-research engine that watches discourse on X, LinkedIn, and Facebook around the clock, tracks evidence-weighted axes via a dynamic ontology, independently verifies factual claims, runs deep-research passes on demand, and archives the record — publishing journals, articles, reports, and checkpoints to a tamper-proof public website.

**Live:** [sebastianhunter.fun](https://sebastianhunter.fun)
**X:** [@SebastianHunts](https://x.com/SebastianHunts)

---

## How it works

Three layers run continuously (see [docs/INVENTORY.md](docs/INVENTORY.md) for the code-anchored ground truth):

- **Mechanical layer** — Node.js scripts handle all scraping, browser automation (via the **HelmStack** substrate), data processing, posting, and git. No LLM.
- **Reasoning layer** — a **local qwen2.5-agent model** (Ollama) reads pre-digested text, interprets it against tracked axes, and writes journals + ontology deltas (`runner/lib/gemini_agent.js` — legacy filename, Ollama loop). Scoring, gating, and planning also run locally (`runner/local_llm.js`).
- **Composition layer** — everything the world actually reads (tweets, quotes, replies, LinkedIn posts, articles) is composed by the **Claude CLI** (`runner/lib/compose.js`, `COMPOSE_BACKEND=claude`). Deep-research reasoning also runs on Claude (`THINK_BACKEND=claude`).

Browse cycles run every ~30 minutes, auto-adjusted between 15–60 minutes by a metacognition engine (`runner/cadence.js`) that reads signal density, axis velocity, post pressure, and staleness. Each cycle:

1. **Tier 1 — Continuous scraper** (always running independently, `scraper/start.sh`):
   - `scraper/collect.js` (every 10 min) — feed ingestion via HelmStack: sanitize → RAKE keywords → Jaccard dedup (0.65) → TF-IDF novelty → local-LLM enrichment of top posts → burst detection → SQLite insert + inline embedding → permanent local posts archive
   - `scraper/follows.js` (every 3 h) — scores follow candidates, classifies via local LLM (30-label taxonomy, trust 1–7); max 3/run, 10/day
   - `scraper/reply.js` (every 30 min) — drains the mention backlog (captured via live search), verifies claims, routes research-intent mentions into deep research, drafts replies via Claude behind the shared outbound gate

2. **Tier 2 — AI browse cycle** (every ~15–60 min):
   - 17-step pre-browse pipeline prepares context (`runner/lib/pre_browse.js`: FTS maintenance, topic summary, memory recall, curiosity, axis clustering, RSS collect, discourse scan, source selection, reading queue, deep-dive detection, prefetch)
   - the local agent reads digest + memory, browses its assigned lead, writes `browse_notes.md` + `ontology_delta.json`
   - `runner/apply_ontology_delta.js` merges evidence through the gate pipeline (source validity, dedup, self-echo, claim fingerprinting, stance validation, diversity constraint, calibrated score recompute, drift cap, decay)

3. **Every 3rd cycle** — quote cycle; **every 6th cycle** — tweet cycle (posting window 07–23 local)
4. **Daily** — articles, belief reports, checkpoints, ponders, stance scan, plan-driven deep research, prediction resolution → git commit → push → Vercel rebuild

Axis score/confidence math lives in `runner/lib/belief_calibration.js`: recency-weighted mean (half-life 100 entries); confidence saturates as `0.95·(1−e^(−weightedSources/35))`. Daily drift is capped at ±0.05 per axis; unobserved axes decay 0.002 confidence/day. New axes require a tension seen ≥6× across ≥4 accounts in ≥2 topic clusters.

### Outbound pipeline

All public output flows through a shared path: **compose (Claude)** → **outbound gates** (`runner/lib/outbound_gates.js`: voice filter + fact-check) → **outbox queue** (`runner/lib/outbox.js`, better-sqlite3, status-tracked, content-dedup) → channel engine. Channel automation lives in the **`tools/helmstack-social`** package (X engine: CreateTweet/CreateRetweet GraphQL + browser drive; LinkedIn engine: voyager + UI drive). LinkedIn is fully on the outbox; X is opt-in via `OUTBOX_X=1`. An amplification learn-loop (`runner/x_amplify.js`, `runner/linkedin_amplify.js`, `runner/amplify_measure.js`) reposts/reshares third-party content and measures what it earns.

### Research subsystems

- **Deep research** (`runner/deep_research.js`) — triage → plan → execute (recall/posts/xsearch/search/fetch/rugcheck/trending) → refine (marks ledger) → resolve (claim verification) → synthesize with a calibrated publish gate. Delivered as website report pages, X threads, or X Articles. Triggered by X mentions, Telegram `/dr`, or daily from the active plan (`runner/plan_research.js`).
- **Stances** (`runner/stance_scan.js`) — committed, spectrum-valued positions on named time-bound events; resolutions feed back into the ontology.
- **Predictions** (`runner/prediction_resolution.js`) — auto-resolution of expired predictions + confidence calibration fed back into generation.
- **Cost self-model** (`runner/lib/cost_meter.js`, `operating_cost.js`) — per-call LLM spend ledger + fixed costs + SOL storage runway → burn rate used in reflection and the website funding section.

---

## Deployment

Sebastian runs on a **local macOS machine** via launchd agents (`~/Library/LaunchAgents`):

| Agent | What |
|---|---|
| `com.sebastian.runner` | `runner/run.sh` → `runner/orchestrator.js` main loop (KeepAlive) |
| `com.sebastian.hunter-helmstack` | HelmStack browser substrate (HTTP API on :7070, dedicated profile) |
| `com.sebastian.browser` | legacy Chrome (CDP :18801) — residual utilities + cookie transplant |
| `com.sebastian.telegram-bot` | `runner/telegram_bot.js` admin commands + alerts |

| Component | What |
|---|---|
| Agent brain | qwen2.5-agent via Ollama (localhost:11434) |
| Outbound prose | Claude CLI (`claude -p`) via `runner/lib/compose.js` |
| Claim-verify + publish + memory workers | Cloud Run (`workers/verify` — Gemini 2.5 Flash via Vertex, `workers/publish`, `workers/memory`) |
| Database | SQLite `state/index.db` (7-day posts window) + `state/outbox.db`; permanent post history in `state/posts_archive/` (append-only NDJSON, monthly files) |
| Embeddings | nomic-embed-text (768-dim) local via Ollama |
| Website | Vercel (Next.js) — built from repo content via `web/scripts/prebuild.js` on push to main |
| Archival | Arweave via Irys (Solana-funded): journals, checkpoints, articles, evidence source URLs |

### Local development

```bash
git clone <repo-url>
cd hunter
cp .env.example .env   # fill in all values
npm install --prefix runner
npm install --prefix scraper
npm install --prefix web
bash runner/run.sh     # starts the main loop
```

### Environment variables

See `.env.example` for the full list. Key vars:

| Variable | Purpose |
|---|---|
| `BROWSE_MODEL` / `LOCAL_CHAT_MODEL` | local reasoning model (qwen2.5-agent) |
| `OLLAMA_BASE_URL` | Ollama endpoint (localhost:11434) |
| `LOCAL_EMBED_MODEL` | embedding model (nomic-embed-text) |
| `COMPOSE_BACKEND` / `THINK_BACKEND` / `BUILDER_BACKEND` = `claude` | route outbound prose / research reasoning / self-mod builds to the Claude CLI |
| `POST_BACKEND=helmstack` | posting via the helmstack-social engines |
| `HELMSTACK_URL` / `HELMSTACK_AUTH_TOKEN` | HelmStack HTTP API (:7070) |
| `OUTBOX_X` | opt X posting into the unified outbox queue |
| `X_USERNAME` / `X_PASSWORD` | X account credentials |
| `GITHUB_TOKEN` / `GITHUB_REPO` | auto-commit + push each cycle |
| `SOLANA_PUBLIC_KEY` / `SOLANA_PRIVATE_KEY` | Arweave uploads via Irys |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | admin control + alerts |
| `VERIFY_WORKER_URL` / `PUBLISH_WORKER_URL` | Cloud Run workers |

---

## Project structure

```
hunter/
├── runner/                       ← orchestration + all mechanical scripts
│   ├── run.sh                    ← entry point (init → orchestrator.js)
│   ├── orchestrator.js           ← main cycle loop (BROWSE/QUOTE/TWEET + daily blocks)
│   ├── cadence.js                ← metacognition engine (cycle timing/type)
│   ├── lib/                      ← ~60 modules; highlights:
│   │   ├── gemini_agent.js       ← agent loop on Ollama (legacy filename)
│   │   ├── compose.js            ← Claude CLI composition backend
│   │   ├── pre_browse.js         ← 17-step pre-cycle pipeline
│   │   ├── post_browse.js        ← post-cycle: archive, claims, signals, replies
│   │   ├── outbox.js             ← channel-agnostic posting queue (state/outbox.db)
│   │   ├── outbound_gates.js     ← shared voice + fact-check gates
│   │   ├── post_x_helmstack.js   ← X posting adapter (helmstack-social engine)
│   │   ├── linkedin_plan.js      ← plan-first LinkedIn posting (A/B shapes)
│   │   ├── belief_calibration.js ← axis score/confidence math (single source of truth)
│   │   ├── amplify_performance.js← amplification learn-loop model
│   │   ├── cost_meter.js / operating_cost.js ← LLM spend + burn-rate self-model
│   │   ├── capabilities.js       ← registry of what Sebastian can actually do
│   │   └── prompts/              ← prompt builders
│   ├── apply_ontology_delta.js   ← evidence gates + belief update
│   ├── deep_research.js          ← triage→plan→execute→refine→resolve→synth
│   ├── plan_research.js          ← plan-driven daily research executor
│   ├── stance_scan.js            ← daily stance formation + resolution
│   ├── prediction_resolution.js  ← auto-resolve expired predictions
│   ├── x_amplify.js / linkedin_amplify.js / amplify_measure.js
│   ├── curiosity.js              ← uncertainty-driven research directive
│   ├── write_article.js / generate_checkpoint.js / ponder.js
│   ├── telegram_bot.js           ← admin bot (/dr deep research, controls)
│   └── builder_vertex.js         ← self-modification builder (Gemini)
│
├── scraper/                      ← continuous background collection (no LLM prose)
│   ├── collect.js                ← feed ingestion pipeline (HelmStack)
│   ├── reply.js                  ← mention processing + research-intent routing
│   ├── follows.js                ← data-driven follow decisions
│   ├── db.js                     ← SQLite schema (posts, keywords, accounts, memory, embeddings)
│   └── start.sh                  ← launches collect/reply/follows loops
│
├── tools/helmstack-social/       ← standalone X + LinkedIn browser-automation engines
├── lib/                          ← shared: belief_system, evidence_processor, theme_clusterer
├── pipelines/                    ← main_pipeline.js, daily_maintenance.js
├── workers/                      ← Cloud Run: verify (Gemini), publish, memory
├── state/                        ← runtime state (see docs/INVENTORY.md §6)
├── journals/ daily/ articles/ ponders/ checkpoints/
├── docs/                         ← reference docs (see Key documents below)
└── web/                          ← Next.js website → sebastianhunter.fun (Vercel)
```

---

## What gets published

Every cycle commits to GitHub and pushes. Vercel rebuilds the site on push; its prebuild step (`web/scripts/prebuild.js`) copies repo content (journals, articles, checkpoints, ponders, daily, reports, selected state files) into `web/data/`.

| Output | Frequency | Description |
|---|---|---|
| `journals/YYYY-MM-DD_HH.html` | Every cycle | Observations, tensions, footnoted sources |
| `daily/belief_report_YYYY-MM-DD.md` | Daily | Full ontology snapshot, axis deltas |
| `articles/YYYY-MM-DD.md` | ~Daily | Long-form piece on an axis (also X Articles, Moltbook) |
| Deep-research reports | On demand + daily plan | Website report pages / X threads / X Articles |
| `ponders/latest.md` | When conviction triggers | Reflective piece + action plans |
| `checkpoints/checkpoint_N.md` | Every 3 days | Axis-state snapshot + drift analysis |
| Predictions + stances | Continuous | Logged, auto-resolved, calibration published |
| `state/ontology.json` | Every cycle | All axes with scores, confidence, evidence |

Journals and checkpoints are permanently archived to **Arweave** via Irys. Evidence source URLs are archived individually so provenance survives deletion. All scraped posts append to the local **posts archive** (`state/posts_archive/YYYY-MM.jsonl`, never pruned; BigQuery streaming was retired in the GCP exit, 2026-07).

---

## Key documents

| File | Purpose |
|---|---|
| [docs/INVENTORY.md](docs/INVENTORY.md) | Code-anchored ground truth: schedules, models, constants (file:line) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system architecture |
| [docs/SYSTEM_DIAGRAM.md](docs/SYSTEM_DIAGRAM.md) | Mermaid flow diagram + layer table |
| [docs/PIPELINE.md](docs/PIPELINE.md) | Pipeline sequences + state file reference |
| [docs/DATA_COLLECTION.md](docs/DATA_COLLECTION.md) | Collection tiers, evidence pipeline, schedules |
| [docs/DEEP_RESEARCH.md](docs/DEEP_RESEARCH.md) | Deep-research pipeline + delivery formats |
| [docs/OUTBOUND.md](docs/OUTBOUND.md) | Outbox, gates, channel engines, amplification |
| [docs/STANCES.md](docs/STANCES.md) / [docs/PREDICTIONS.md](docs/PREDICTIONS.md) / [docs/COSTS.md](docs/COSTS.md) | Stances, predictions + calibration, cost self-model |
| [docs/VERIFICATION_PIPELINE.md](docs/VERIFICATION_PIPELINE.md) | Claim verification scoring and lifecycle |
| [AGENTS.md](AGENTS.md) | Belief ontology rules (prompt material for the agent) |
| [SOUL.md](SOUL.md) | Persona layer: voice, conviction tiers, safety boundaries |

---

## Troubleshooting

**Service status**
```bash
launchctl list | grep sebastian
tail -f runner/runner.log
```

**Restart the runner**
```bash
launchctl kickstart -k gui/$(id -u)/com.sebastian.runner
```

**HelmStack stuck**
```bash
launchctl kickstart -k gui/$(id -u)/com.sebastian.hunter-helmstack
tail -f runner/hunter-helmstack.log
```

**Scraper loops**
```bash
tail -f scraper/scraper.log     # collect/reply/follows share this log
```

**X session expired**
Re-run the cookie transplant (`runner/helmstack_bootstrap.js`) or let the engine re-authenticate with `X_USERNAME`/`X_PASSWORD`.

**Note on restarts:** the runner has a restart-in-sleep-window rule — avoid manual restarts during the active posting window; prefer the sleep window (see HEARTBEAT/cadence state).
