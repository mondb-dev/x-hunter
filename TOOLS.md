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
| `gemini_agent.js` | RETIRED stub — agent loop removed with the Ollama transport |
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
| `daily.js` | Daily block: report, article, checkpoint, ponder, sprint, housekeeping. Exports `pruneClaudeDebugLogs` (age + size cap) — called EVERY cycle from orchestrator.js, not daily: ~/.claude/debug grows ~1.3 GB/hour unpruned |
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
| `collect.js` | Feed ingestion via HelmStack; mention capture via live search; appends to permanent local posts archive |
| `reply.js` | Mention queue: spam filter → thread context → recall → Claude classify+draft → outbound gate → HelmStack reply. Research-intent mentions route to deep_research. 3/run, 5 min gap, 10/day |
| `follows.js` | Follow scoring + HelmStack follow. 3/run, 10/day |
| `rss_collect.js` | RSS feeds (GMA News, PCIJ, …) into the digest |
| `db.js` | SQLite schema: posts, keywords, accounts, memory, embeddings (`state/index.db`) |
| `analytics.js` | RAKE, TF-IDF, Jaccard, burst detection |
| `query.js` | Topic summary extraction |

## Channel engines (`tools/helmstack-social/`)

Standalone package driving X, LinkedIn and Gemini through HelmStack:
X — CreateTweet/CreateRetweet GraphQL, quotes/replies via API, browser image
upload, X Articles (Premium editor flow); LinkedIn — voyager posting + media
pipeline, UI-driven reshare, comments; Gemini — `ask()` for claim verification
plus image/video generation on the signed-in Google account.

**Gemini chats clean up after themselves.** That account belongs to a human and
its history is shared with their own chats, so every `ask`/`generate` deletes the
conversation it created once the answer or bytes are in hand. `GEMINI_KEEP_CHATS=1`
keeps them for debugging. To clear chats left by older runs:

```
# --env-file is required: HELMSTACK_URL/_AUTH_TOKEN come from .env, and the
# default port (7070) is not the one this box runs (7071).
node --env-file=.env tools/helmstack-social/bin/helmstack-social.js gemini purge         # dry run
node --env-file=.env tools/helmstack-social/bin/helmstack-social.js gemini purge --apply # delete
```

A chat is only deleted when it has **exactly one turn** AND that turn matches
one of the prompts this engine writes (`Gemini.AGENT_PROMPT_PATTERNS`). Titles are
never matched — Gemini writes those, and a human chat easily reads like a
fact-check. The turn count carries real weight: Gemini renders long chats lazily,
so the topmost bubble is whichever turn is loaded rather than the opening one,
while every chat this engine creates is a fresh single-turn one.

**Cadence.** Identifying a chat costs one page load, and back-to-back loads are
what trip Google's anti-abuse interstitial — it's the request rate that gets
noticed. The run throttles itself: `--pause-ms` (default 9000) jittered by
`--jitter` (0.4) between chats, plus a `--rest-ms` (120s) rest every
`--rest-every` (8) chats. A full ~40-chat sweep therefore takes 12–15 minutes.
`--max N` / `--max-scan N` split it into smaller sittings. If the interstitial
appears anyway the run stops and says so — clearing it is a human's job.

**Concurrency.** The purge opens its own browser tab and closes it at the end, so
a fact-check running in the shared tab mid-sweep no longer steers the page out
from under it (that cost 12 of 37 chats to "did not load" in one run). Each chat
also gets one retry before being recorded as a failure.

**Report.** Every run ends with a summary — counts, then the deleted chats listed
by title and id, then anything it could not process — and writes the same as JSON
to `helmstack/gemini_purge/<timestamp>.json` (`--report FILE` to place it,
`--no-report` to skip). The report records only the chats it ACTED on: the account
owner's chats are read to rule them out and then forgotten, so their titles never
reach a file. `helmstack/` is gitignored, which is what keeps a private chat list
out of the repo.

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
| Agent brain (browse/journal/ontology) | Claude | `CLAUDE_THINK_MODEL` |
| Scoring / gating / planning | Claude | `CLAUDE_COMPOSE_MODEL` |
| Outbound prose | Claude CLI (`claude -p`) | `COMPOSE_BACKEND=claude`, `CLAUDE_COMPOSE_MODEL`, `CLAUDE_ARTICLE_MODEL` |
| Research reasoning | Claude CLI | `THINK_BACKEND=claude`, `CLAUDE_THINK_MODEL` |
| Embeddings (768-dim) | **disabled** (no Claude endpoint) | — |
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
  utilities + `runner/helmstack_bootstrap.js` cookie transplant. Always-on
  (`KeepAlive`), same as before.

  **Must run Chrome for Testing, never `/Applications/Google Chrome.app`.**
  That bundle shares its identifier (`com.google.Chrome`) with the user's desktop
  browser, so while a `--headless=new` process from it is alive, macOS
  LaunchServices routes a normal Chrome launch to the windowless process — the
  desktop browser silently never opens a window. A separate `--user-data-dir`
  does not help; the collision is at the bundle level. Chrome for Testing has its
  own id (`com.google.chrome.for.testing`), so the two coexist.

  | Setting | Value |
  |---|---|
  | `CHROME_BIN` (.env) | `~/.local/bin/chrome-hunter` — wrapper `exec`ing the CfT binary |
  | `CHROME_USER_DATA_DIR` (.env) | `~/.config/chrome-for-testing/x-hunter` |
  | `CDP_AUTOSTART` (.env) | `1`; set `0` as a kill switch to stop all autostart |

  The wrapper exists because Chrome resolves `../Frameworks` from its own path —
  a symlink to the binary breaks `dlopen` — while the real path contains spaces,
  which `set -a; source .env` in `run.sh` cannot handle unquoted.

  Old profile (`~/.config/google-chrome/x-hunter`, Chrome 150) is left in place;
  the new one was seeded from its `Default/Cookies`. Don't point CfT 146 at the
  old profile directly — Chrome refuses a profile written by a newer version.
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
CLAUDE_COMPOSE_MODEL / CLAUDE_THINK_MODEL / CLAUDE_RETRIES / CLAUDE_BIN
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
