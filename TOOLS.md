# TOOLS.md — System Reference

How the system runs, what each script does, and what the agent actually touches.

---

## How sessions run

The system runs on a cloud VM as a systemd service.

```
run.sh (init: login, env, checks) → exec → orchestrator.js (main loop)
```

- **Cycle time**: ~20 minutes per cycle
- **Cycle types**: 5 BROWSE → 1 TWEET → repeat, with daily/checkpoint triggers
- **Sleep**: `setTimeout`-based (no `Atomics.wait`), SIGTERM-safe
- **systemd**: Restart=always, SIGTERM-safe shutdown

Start/stop on the VM:
```bash
sudo systemctl start sebastian-runner
sudo systemctl stop sebastian-runner
journalctl -u sebastian-runner -f    # live logs
```

---

## Orchestrator (`runner/orchestrator.js`)

The main loop. 591 lines. Decides cycle type, invokes the agent, runs
pre/post hooks, handles errors and retries.

Key functions:
- `runOneCycle()` — single cycle: pre-hooks → agent → post-hooks → git → sleep
- Cycle routing: BROWSE, TWEET, DAILY, CHECKPOINT based on counters
- Structured JSON logging to stdout (parsed by journald)

---

## Lib modules (`runner/lib/`)

| Module | Purpose |
|---|---|
| `agent.js` | Send prompt to OpenClaw agent, collect response |
| `browser.js` | Browser lifecycle: start, stop, snapshot, health check |
| `config.js` | Load `.env`, export paths and constants |
| `state.js` | Read/write JSON state files atomically |
| `pre_browse.js` | Pre-browse hooks: scraper freshness check, feed digest |
| `post_browse.js` | Post-browse hooks: save notes, update seen_ids |
| `pre_tweet.js` | Pre-tweet hooks: memory recall, voice filter, conviction tier |
| `post.js` | Posting: `post_tweet.js` / `post_quote.js` via CDP, then `posts_log.js` |
| `daily.js` | Daily report + checkpoint generation triggers |
| `git.js` | `git add` / `commit` / `push` — runs after every cycle |

---

## Runner scripts (`runner/`)

### Core pipeline
| Script | What it does |
|---|---|
| `orchestrator.js` | Main loop (see above) |
| `llm.js` | LLM abstraction — routes to Gemini, OpenAI, or Vertex |
| `vertex.js` | Vertex AI (Gemini) direct API client |
| `cdp.js` | Chrome DevTools Protocol helpers (type, click, navigate) |
| `voice_filter.js` | Conviction-tier enforcement: shapes tweet length/directness |
| `decision.js` | Decides what to do in a tweet cycle (post, quote, skip) |
| `critique.js` | Self-critique before posting |
| `critique_tweet.js` | Refine tweet draft via LLM |
| `recall.js` | Query SQLite memory for relevant past journals/checkpoints |

### Posting
| Script | What it does |
|---|---|
| `post_tweet.js` | Post a tweet via CDP (navigate, type, submit) |
| `post_quote.js` | Post a quote-tweet via CDP |
| `post_article.js` | Post a long-form article tweet |
| `post_and_pin.js` | Post and pin a tweet |
| `delete_tweet.js` | Delete a tweet by URL |
| `delete_and_repost_quote.js` | Delete a broken quote and repost |
| `posts_log.js` | Append post metadata to `state/posts_log.json` |

### Belief system
| Script | What it does |
|---|---|
| `apply_ontology_delta.js` | Merge `ontology_delta.json` into `ontology.json` |
| `cluster_axes.js` | Cluster related axes by topic similarity |
| `detect_drift.js` | Detect score drift and apply caps |
| `evaluate_vocation.js` | Check vocation trigger conditions (§14) |

### Content & discovery
| Script | What it does |
|---|---|
| `discourse_scan.js` | Scan feed for recurring tensions |
| `discourse_digest.js` | Summarize feed content into digest |
| `curiosity.js` | Generate curiosity directives; sprint-aware during silent hours (UTC 23-07) |
| `deep_dive_detector.js` | Detect topics worth a deep dive |
| `deep_dive.js` | Execute a deep-dive research session |
| `reading_queue.js` | Manage reading queue for articles/threads |
| `prefetch_url.js` | Prefetch a URL for offline reading |
| `comment_candidates.js` | Find tweets worth replying to |
| `check_notifs.js` | Check notifications for replies/mentions |

### Reports & output
| Script | What it does |
|---|---|
| `generate_daily_report.js` | Generate `daily/belief_report_YYYY-MM-DD.md` |
| `generate_checkpoint.js` | Generate `checkpoints/checkpoint_N.md` |
| `capture_detection.js` | Daily source-capture detection (no LLM). Writes `state/capture_state.json` |
| `posts_assessment.js` | Daily posting self-review (LLM). Writes `daily/posts_assessment_YYYY-MM-DD.md` + `state/posting_directive.txt` |
| `write_article.js` | Write a long-form article to `articles/` |
| `ponder.js` | Write a reflection to `ponders/` |
| `update_bio.js` | Update X bio via CDP |
| `sprint_manager.js` | Multi-day sprint planning |
| `sprint_update.js` | Sprint progress update |

### Infrastructure
| Script | What it does |
|---|---|
| `archive.js` | Index journals/checkpoints into SQLite; Irys/Arweave upload |
| `backfill_embeddings.js` | Backfill embedding vectors for memory search |
| `backfill_ponder1.js` | One-off backfill for ponder entries |
| `browser_check.js` | Health-check the browser CDP connection |
| `cleanup_tabs.js` | Close excess browser tabs |
| `vision.js` | Screenshot + vision analysis via LLM |
| `watchdog.js` | Process watchdog — restarts stalled components |
| `moltbook.js` | Moltbook integration |
| `moltbook_register.js` | Register with Moltbook |

---

## Scraper (`scraper/`)

Runs independently. Collects the X feed and stores it in SQLite.

| File | Purpose |
|---|---|
| `collect.js` | Scrape feed via puppeteer-core / CDP |
| `embed.js` | Generate embeddings for scraped tweets |
| `analytics.js` | Feed analytics and stats |
| `query.js` | Query the scraper database |
| `db.js` | SQLite database helpers |
| `follows.js` | Manage follows (automated via trust_graph rules) |
| `reply.js` | Reply to tweets via CDP |
| `start.sh` / `stop.sh` | Start/stop the scraper |

Database: `scraper/hunter.db` (SQLite)

---

## Scripts (`scripts/`)

Utility and test scripts.

| File | Purpose |
|---|---|
| `gen-wallet.js` | Generate a Solana wallet keypair |
| `retroactive_event_scan.js` | Scan for retroactively-validated predictions |
| `wire_prompts.py` | Wire prompt templates |
| `parity_test.js` | Parity check between old and new systems |
| `test_phase*.js` | Test suites (phases 2b–6, 38 tests total) |

---

## State files (`state/`)

28 JSON files. The orchestrator and runner scripts read/write these atomically
via `runner/lib/state.js`.

### Core belief state
| File | Contents |
|---|---|
| `ontology.json` | All discovered belief axes (schema per AGENTS.md §3) |
| `belief_state.json` | Current scores, confidence, day/cycle counters |
| `diversity_state.json` | 40/30/30 diversity tracking (§7) |
| `drift_state.json` | Score drift detection state |
| `drift_cap_state.json` | Daily drift cap tracking |
| `capture_state.json` | Capture detection alerts: source/cluster/pole/axis concentration |
| `posting_directive.txt` | 3 specific posting rules for tomorrow (from posts_assessment.js) |
| `cadence.json` | Self-regulated cadence: cycle interval, depth, eagerness, focus |
| `axis_creation_state.json` | Axis creation cooldowns and counters |
| `axes_graveyard.json` | Merged/retired axes |

### Trust & interactions
| File | Contents |
|---|---|
| `trust_graph.json` | Per-account weights, follow status, notes |
| `interactions.json` | Reply/mention interaction log |
| `comment_log.json` | Comment/reply history |
| `seen_ids.json` | Tweet IDs already processed |

### Posts & publishing
| File | Contents |
|---|---|
| `posts_log.json` | Every tweet posted (id, content, type, URL, timestamp) |
| `profile.json` | X profile state (bio, pfp, community) |

### Vocation & planning
| File | Contents |
|---|---|
| `vocation.json` | Vocation status, trigger day, core axes, intent |
| `action_plans.json` | Current action plans |
| `active_plan.json` | The active plan being executed |
| `sprint_snapshot.json` | Current sprint state |
| `last_sprint_update.json` | Last sprint update timestamp |

### Content pipeline
| File | Contents |
|---|---|
| `reading_queue_state.json` | URLs queued for deep reading |
| `discourse_scan_state.json` | Discourse scan progress |
| `research_briefs.json` | Research briefs from deep dives |
| `ponder_state.json` | Ponder/reflection state |
| `article_state.json` | Article writing state |

### System
| File | Contents |
|---|---|
| `health_state.json` | System health metrics |
| `checkpoint_state.json` | Checkpoint generation tracking |
| `retroactive_events.json` | Retroactively-validated prediction events |
| `arweave_log.json` | Arweave/Irys upload log |
| `moltbook_state.json` | Moltbook registration state |

---

## LLM configuration

Three LLM providers, used for different tasks:

| Provider | Model | Used for | Env vars |
|---|---|---|---|
| Google Gemini | `gemini-2.5-flash` | Articles (`write_article.js`) | `GOOGLE_API_KEY` |
| OpenAI-compatible | Configurable (default: `gpt-4o`) | Checkpoints, ponders | `OPENAI_API_KEY`, `OPENAI_API_BASE_HOST`, `OPENAI_MODEL` |
| OpenClaw / Gemini | `google/gemini-2.5-flash` | Agent browsing, tweets, journals | Configured in `~/.openclaw/openclaw.json` |

---

## Browser

- **Runtime**: Chrome via OpenClaw, controlled through CDP
- **Gateway**: OpenClaw gateway
- **Profile**: set via `OPENCLAW_PROFILE` in `.env`
- **Interaction**: All browser operations use `runner/cdp.js` (puppeteer-core)

Commands (run on VM):
```bash
openclaw browser --browser-profile x-hunter start
openclaw browser --browser-profile x-hunter snapshot
openclaw browser --browser-profile x-hunter stop
openclaw gateway status
```

---

## Solana wallet

- Generate: `node scripts/gen-wallet.js`
- Env: `SOLANA_PUBLIC_KEY`, `SOLANA_PRIVATE_KEY`
- Uses: on-chain identity, Arweave uploads, future pump.fun interactions

---

## Streaming

- Start: `bash stream/start.sh`
- Stop: `bash stream/stop.sh`
- Goes live on pump.fun tied to the agent's token
- Never navigate to login/credentials pages while streaming

---

## Git (automated)

Every cycle, `runner/lib/git.js` runs:
```bash
git add journals/ state/ daily/ checkpoints/ articles/ ponders/ vocation.md
git commit -m "cycle <N>: YYYY-MM-DD HH:MM"
git push origin main
```

Requires: `GITHUB_TOKEN`, `GITHUB_REPO`, `GIT_USER_NAME`, `GIT_USER_EMAIL`

A Vercel deploy hook (`VERCEL_DEPLOY_HOOK`) triggers website rebuild after push.

---

## Environment variables (`.env`)

```
GOOGLE_API_KEY          — Gemini API key
OPENAI_API_KEY          — OpenAI-compatible API key
OPENAI_API_BASE_HOST    — API base host (api.openai.com, api.x.ai, etc.)
OPENAI_MODEL            — Model name (gpt-4o, grok-3, etc.)
X_USERNAME              — X login username
X_PASSWORD              — X login password
OPENCLAW_PROFILE        — Browser profile name (x-hunter)
GITHUB_TOKEN            — GitHub PAT for push
GITHUB_REPO             — Repo slug (owner/repo)
GIT_USER_NAME           — Git commit author name
GIT_USER_EMAIL          — Git commit author email
VERCEL_DEPLOY_HOOK      — Optional: Vercel deploy webhook URL
PAYMENT_ADDRESS         — Base wallet for x402 micropayments (USDC)
SOLANA_PUBLIC_KEY       — Solana public key
SOLANA_PRIVATE_KEY      — Solana private key
```

---

## Logging

Structured JSON to stdout, captured by systemd/journald.

Prefixes (in structured log `category` field):
- `[observe]` — feed observations
- `[update]` — belief updates
- `[axis:new]` — new axis creation
- `[post]` — tweet posted
- `[vocation]` — vocation events
- `[profile]` — profile changes
- `[error]` — errors
