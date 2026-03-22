# Sebastian D. Hunter

An autonomous AI agent that observes discourse on X (Twitter), forms a worldview from scratch via a dynamic belief ontology, and publishes journals, articles, and belief checkpoints to the web.

**Live:** [sebastianhunter.fun](https://sebastianhunter.fun)
**X:** [@sebastianhunts](https://x.com/sebastianhunts)

---

## How it works

The system has two layers:

- **Mechanical layer** — Node.js scripts handle all scraping, browser automation, data processing, and posting. No LLM involved.
- **Reasoning layer** — Gemini 2.5 Flash (via OpenClaw) reads pre-digested text, thinks, and writes text. No browser access, no shell commands.

The agent runs continuously in ~20-minute cycles. Each cycle:

1. `scraper/collect.js` ingests the X feed via CDP, scoring and clustering posts through a 12-phase analytics pipeline
2. The LLM receives a pre-digested digest, updates `browse_notes.md`, and adjusts belief axes in `ontology.json`
3. Every 6th cycle: the LLM drafts a tweet or quote-tweet → mechanical scripts post it via CDP
4. Once per day: articles, daily belief reports, and ponders are generated → committed to GitHub → Vercel auto-deploys
5. Every 3 days: a full **checkpoint** (worldview snapshot) is generated

The agent started with zero ideology and discovers belief axes only when recurring tensions appear across multiple accounts and topics.

---

## Deployment

Sebastian runs on a cloud VM as a systemd service. See [deploy/README.md](deploy/README.md) for full setup.

| Component | What |
|---|---|
| Service | systemd (Type=simple, Restart=always) |
| Browser | Chrome via OpenClaw (CDP) |
| Orchestrator | `runner/orchestrator.js` (Node.js, replaces bash main loop) |
| Website | Vercel, auto-deploys on push to `main` |

### Local development

```bash
git clone <repo-url>
cd hunter
cp .env.example .env   # fill in all values
npm install --prefix runner
npm install --prefix scraper
npm install --prefix web
bash runner/setup.sh   # one-time: installs OpenClaw, opens Chrome for X login
bash runner/run.sh     # starts the main loop
```

### Environment variables

See `.env.example` for the full list. Key vars:

| Variable | Purpose |
|---|---|
| `GOOGLE_API_KEY` | Gemini API (articles, generation) |
| `OPENAI_API_KEY` / `OPENAI_API_BASE_HOST` | OpenAI-compatible API (checkpoints, ponders) |
| `X_USERNAME` / `X_PASSWORD` | X account credentials |
| `GITHUB_TOKEN` / `GITHUB_REPO` | Auto-commit + push |
| `VERCEL_DEPLOY_HOOK` | Optional: trigger Vercel redeploy |
| `SOLANA_PUBLIC_KEY` / `SOLANA_PRIVATE_KEY` | On-chain identity (Arweave uploads) |

---

## Project structure

```
x-hunter/
├── runner/                       ← orchestration + all mechanical scripts
│   ├── run.sh                    ← entry point (init, then exec → orchestrator.js)
│   ├── orchestrator.js           ← main cycle loop (Node.js, SIGTERM-safe)
│   ├── lib/                      ← extracted modules
│   │   ├── agent.js              ← spawnSync wrapper for openclaw CLI
│   │   ├── browser.js            ← CDP health, gateway, browser start/stop
│   │   ├── config.js             ← env + paths
│   │   ├── state.js              ← session reset, lock cleanup, backup
│   │   ├── pre_browse.js         ← pre-cycle: query.js, recall.js, prefetch
│   │   ├── post_browse.js        ← post-cycle: archive, curiosity, deep_dive
│   │   ├── pre_tweet.js          ← pre-tweet: discourse scan, sprint update
│   │   ├── post.js               ← post tweet/quote via CDP, log to posts_log
│   │   ├── daily.js              ← daily block: report, article, checkpoint, ponder
│   │   ├── git.js                ← commit + push + Vercel deploy hook
│   │   └── prompts/              ← prompt builders (browse, tweet, quote, context)
│   ├── post_tweet.js             ← CDP tweet posting
│   ├── post_quote.js             ← CDP quote-tweet posting
│   ├── write_article.js          ← long-form article generation (Vertex)
│   ├── generate_checkpoint.js    ← worldview checkpoint generation
│   ├── generate_daily_report.js  ← daily belief report
│   ├── ponder.js                 ← compulsion engine (vocation + action plans)
│   ├── curiosity.js              ← uncertainty-driven browsing direction
│   ├── deep_dive.js              ← deep-dive into specific accounts/topics
│   ├── voice_filter.js           ← conviction tier enforcement for tweets
│   ├── watchdog.js               ← health monitoring
│   ├── moltbook.js               ← Moltbook social protocol integration
│   ├── archive.js                ← SQLite index + Arweave upload
│   ├── recall.js                 ← FTS5 BM25 memory retrieval
│   ├── llm.js                    ← Gemini REST client
│   ├── vertex.js                 ← Vertex AI client (articles)
│   └── cdp.js                    ← Chrome DevTools Protocol helpers
│
├── scraper/                      ← background data collection (no LLM)
│   ├── collect.js                ← 12-phase feed analytics pipeline
│   ├── reply.js                  ← mention processing + reply (Gemini classify)
│   ├── follows.js                ← data-driven follow decisions
│   ├── db.js                     ← SQLite schema + queries
│   ├── embed.js                  ← embedding generation
│   ├── analytics.js              ← scoring algorithms
│   └── query.js                  ← topic summary extraction
│
├── scripts/                      ← utilities + tests
│   ├── test_phase5.js            ← orchestrator unit tests (24 tests)
│   ├── test_phase6.js            ← structured logging tests (14 tests)
│   ├── retroactive_event_scan.js ← historical event detection
│   └── gen-wallet.js             ← Solana wallet generation
│
├── state/                        ← runtime state (28 JSON files)
│   ├── ontology.json             ← all belief axes (scores, confidence, evidence)
│   ├── trust_graph.json          ← per-account influence weights
│   ├── posts_log.json            ← all tweets posted
│   ├── vocation.json             ← discovered vocation direction
│   ├── profile.json              ← X profile state
│   ├── drift_state.json          ← CUSUM drift detection per axis
│   ├── retroactive_events.json   ← detected discourse anomalies
│   ├── interactions.json         ← reply/mention log
│   └── ...                       ← 20 more state files (see ARCHITECTURE.md)
│
├── journals/                     ← hourly HTML journals (agent-written)
├── daily/                        ← daily belief reports
├── articles/                     ← long-form field reports
├── ponders/                      ← reflective pieces
├── checkpoints/                  ← 3-day worldview snapshots
│
├── AGENTS.md                     ← belief ontology rules (axis creation, update formula)
├── SOUL.md                       ← persona, voice, safety boundaries
├── ARCHITECTURE.md               ← full system architecture + data flow
├── TOOLS.md                      ← agent-facing tool/command reference
├── vocation.md                   ← agent-generated vocation statement
│
├── web/                          ← Next.js website → sebastianhunter.fun
├── deploy/                       ← GCP deployment scripts + docs
├── stream/                       ← optional live streaming
└── docs/                         ← bug tracker, pipeline status, guides
```

---

## What gets published

Every cycle commits to GitHub, triggering a Vercel redeploy:

| Output | Frequency | Description |
|---|---|---|
| `journals/YYYY-MM-DD_HH.html` | Every cycle (~20min) | Observations, tensions, footnoted sources |
| `daily/belief_report_YYYY-MM-DD.md` | Once per day | Full ontology snapshot, axis deltas |
| `articles/YYYY-MM-DD.md` | ~Daily | Long-form field report on a belief axis |
| `ponders/latest.md` | When conviction triggers | Reflective piece + action plans |
| `checkpoints/checkpoint_N.md` | Every 3 days | Complete worldview snapshot + drift analysis |
| `state/ontology.json` | Every cycle | All 32 belief axes with scores + confidence |

Articles are permanently archived to **Arweave** via Irys. Tweet records are logged to **Moltbook**.

---

## Key documents

| File | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system architecture, data flow, algorithms |
| [AGENTS.md](AGENTS.md) | Belief ontology rules: axis creation, update formula, manipulation detection |
| [SOUL.md](SOUL.md) | Persona layer: voice, conviction tiers, safety boundaries |
| [TOOLS.md](TOOLS.md) | Agent-facing reference for available scripts and state files |
| [deploy/README.md](deploy/README.md) | GCP deployment: VM setup, systemd, maintenance |
| [docs/PIPELINE.md](docs/PIPELINE.md) | Pipeline status: all automated workflows and their scripts |
| [audit_round3.md](audit_round3.md) | Latest codebase audit (2026-03-15): open bugs + debt |

---

## Troubleshooting

**Service status**
```bash
# On VM:
systemctl status sebastian-runner
```

**View logs**
```bash
# On VM:
journalctl -u sebastian-runner --no-pager -n 50
```

**Gateway not starting**
```bash
openclaw gateway status
openclaw gateway start
openclaw doctor
```

**X session expired**
The agent re-authenticates automatically using `X_USERNAME` / `X_PASSWORD` from `.env`.

**Browser stuck / CDP timeout**
```bash
# On VM:
pkill -f chrome && sleep 5 && openclaw browser --browser-profile x-hunter start
```
