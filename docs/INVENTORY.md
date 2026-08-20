# Codebase Inventory — ground truth as of 2026-07-19

Code-derived snapshot (docs/archive/DOCS_SYNC_PLAN.md Phase 0). Every claim below carries its
source file so future audits are one grep away. When a doc disagrees with this file,
the doc is wrong or the code moved — re-verify here first.

## 1. Entry points & schedules (launchd, local Mac)

| Agent (`~/Library/LaunchAgents`) | Runs | Notes |
|---|---|---|
| `com.sebastian.runner` | `bash runner/run.sh` (KeepAlive) | init → `runner/orchestrator.js` main loop; logs `runner/runner.log` |
| `com.sebastian.browser` | `~/.local/bin/chrome-hunter --remote-debugging-port=18801` | legacy CDP Chrome, KeepAlive. Runs **Chrome for Testing** (`com.google.chrome.for.testing`) via a wrapper script — never `/Applications/Google Chrome.app`, whose `com.google.Chrome` bundle id is shared with the user's desktop browser and makes a headless instance swallow their Chrome launches. Binary/profile from `CHROME_BIN` + `CHROME_USER_DATA_DIR` (.env), honored by `runner/lib/browser.js:launchChrome` and `runner/run.sh:64`. `CDP_AUTOSTART=0` kills autostart (`run.sh:57`, `lib/browser.js:startBrowser/ensureBrowser/waitForBrowserService`, `orchestrator.js:701,720`) |
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

Scraper loops (`scraper/start.sh:23-26`): mentions 120s · collect 300s · reply 600s · follows 10800s.
  - **mentions** (`scraper/mentions.js`) is a fast, lightweight mention poller:
    own dedicated HelmStack tab, notifications + live-search capture via the
    shared `scraper/lib/reply_queue.js` (dedup + append; collect.js Phase 12 uses
    the same module as an every-5-min fallback). On new mentions it triggers a
    detached reply run so a mention doesn't wait for the next reply tick.
    `MENTIONS_INTERVAL=0` disables it (collect.js still captures);
    `MENTIONS_TRIGGER_REPLY=0` = capture only. Failures are non-fatal (exit 0).
  - Reply posting rate stays throttled independently of the loop cadence:
    `MIN_GAP_MS` 5 min between replies, `MAX_PER_RUN` 3, `MAX_PER_DAY` 10
    (`scraper/reply.js:73-76`). The min-gap since the last reply is waited out
    in-process, not skipped to the next cycle. reply.js is a singleton via a
    reclaimable run-lock (`state/reply.run.lock`, 20-min stale TTL) so the
    scheduled run and a poller-triggered run never double-post.

## 2. Inference: Claude for everything Sebastian says; local for bounded scoring

**POLICY: Claude is the only LLM for generated prose and judgement.**
Gemini/Vertex was retired first, the local Ollama brain second (2026-07-30,
after the model store was wiped and every local path 404'd for ~2.3 days). There
is no fallback backend by design — a silent substitution to a weaker model is
what this policy exists to prevent.

**Narrow exception (2026-08-19): relevance scoring may run locally.**
`runner/lib/local_llm.js` routes 0-3 relevance classification to Ollama
(`qwen2.5:3b`) when `LOCAL_LLM_ENABLED=1`. Scoring is bounded classification —
one digit — which is the one shape a ~3B model handles adequately, and it is the highest-frequency LLM call in the system (~25 candidates per
engagement run, on both X and LinkedIn, at a 90s Claude timeout each).

This is an exception, not a reopening of the policy. It holds because:

- **Routing is explicit and per-call-site.** Nothing reroutes silently, and the
  local path never escalates to Claude. Chaining backends per call is exactly
  what produced `Claude 429s → local 404s → retry → 18 failures in one cycle`.
- **Absence is loud.** `isAvailable()` resolves the model *by name* and returns a
  reason. The 2026-07-28 wipe was invisible because `ollama serve` kept returning
  `200 {"models":[]}` while every model 404'd.
- **Model is `qwen2.5:3b`; phi4-mini was tried first and replaced.** Scored
  head-to-head on the same 10 real feed items, phi4-mini returned "2" for ALL
  TEN (including a Tupac murder trial and an ICE detention) — on political copy
  it stops discriminating and, at minScore=2, waves everything through.
  qwen2.5:3b used the full range and gave a correct 3 to media-framing copy.
  Live: phi4-mini passed 10-11 of 23 LinkedIn candidates, qwen2.5:3b 3 of 22.
  Keep exactly ONE model pulled — swapping two ~2GB models thrashes this 16GB box.
- **Default mode is `prefilter`, not `only`.** Local drops the confident 0s and
  **Claude ranks the survivors**. `LOCAL_LLM_MODE=only` skips Claude entirely and
  exists for quota outages where degraded engagement beats none.
- **Prompt shape carries the quality.** An abbreviated prompt returned a constant
  `2` for everything; the production prompt's explicit anti-examples ("job
  updates, congratulations, ads = 0") are what produce the separation. Those
  anti-examples are load-bearing — do not tidy them out.

Composition, gating, and fact-checking stay on Claude. In particular the
fact-check gate (`lib/outbound_gates.js`) must not run locally: it fails *open*,
so a weak checker does not block bad output, it waves it through.

Cold start is ~75-110s on this M4/16GB, then ~0.2-1.4s warm; `isAvailable()` warms
the model so that cost lands on the probe, not the first scored post.

Everything funnels through `runner/lib/compose.js`:

| Entry point | Use | Notes |
|---|---|---|
| `compose(prompt, opts)` | outbound prose | `DEFAULT_SYSTEM`, ~120s timeout |
| `reason(prompt, opts)` | cognition / JSON stages | `REASON_SYSTEM`, ~180s timeout, strips ``` fences |
| `composeJSON(prompt, schema, opts)` | schema-constrained JSON | replaces Ollama's `format:` grammar; prompt-level schema + one corrective retry on parse failure |
| `claudeCompose(prompt, opts)` | single attempt, no retry | the primitive |
| `callVertex(prompt, maxTokens, opts)` | **compat shim only** | `runner/vertex.js` → `claudeCompose`. ~16 legacy callers. New code should not use it. `maxTokens`/`temperature` accepted and ignored — no CLI equivalent |

`withRetry()` retries **529 Overloaded** and kill-timeouts with exponential
backoff + jitter (`CLAUDE_RETRIES`, default 3). It deliberately does **not**
retry quota exhaustion ("out of extra usage"), which resets on a multi-hour
window — in-cycle retries only burn wall-clock (`compose.js isTransient()`).

| Role | Model | Where |
|---|---|---|
| Agent brain (browse/journal/ontology) | **Claude** via single-pass browse | `runner/single_pass_browse.js` — one `composeJSON` call against `BROWSE_SCHEMA`. The 40-turn agentic loop is **retired**: `runner/lib/gemini_agent.js` is a fast-failing stub so callers drop to their direct-compose fallbacks |
| Scoring / gating / planning / voice rewrite | **Claude** | `runner/llm.js generate()` → `compose()`. Throws if Claude is unavailable; there is no local path and no `localOnly` option any more. **Every call is a subprocess** (~7s warm): callers that used to fan a batch out in parallel against the old local brain must bound their concurrency and budget ≥90s per call, or all of them time out at once |
| Outbound prose (tweets, quotes, replies, LinkedIn, articles) | **Claude CLI** (`claude -p`) | `runner/lib/compose.js` — full system-prompt override, no tools, no MCP |
| Deep-research reasoning (plan, refine, synth) | **Claude CLI** | `runner/deep_research.js` header |
| Embeddings (768-dim) | **DISABLED** — Claude has no embedding endpoint | `runner/llm.js embed()` returns `null` unconditionally. Callers degrade to keyword search (`recall.js` → sqlite fts5). Stored vectors are inert (nomic-embed-text space, nothing produces new ones). Re-enabling = pick a provider + `backfill_embeddings.js` to re-embed the corpus |
| Claim verification (local intelligence scripts) | **HelmStack browser search + Gemini WEB APP** (session-based, no API key) | `runner/intelligence/lib/web_search.js webSearchVerify` — search via `lib/helmstack_fetch searchWeb` (CDP scraper as fallback), judgement via `Gemini.ask()` in `tools/helmstack-social/src/gemini.js`. ~22s/claim. Each ask **deletes its own Gemini chat** when it finishes (`GEMINI_KEEP_CHATS=1` to keep them) — the signed-in account is the operator's personal one and fact-checks were burying their own chats. The Vertex API grounding path is **deleted**. `workers/verify/index.js:137` (Cloud Run) is separate and still Vertex |
| Media/vision description | **Claude** (multimodal) | `runner/vision.js` — image passed as a base64 CONTENT BLOCK over `claude -p --input-format stream-json` (no tools; the Read-an-image-path route needs the Read tool, which trips `tool_use ids must be unique`). Mime is sniffed from magic bytes, not trusted from the scrape. `VISION_CONCURRENCY` (2), `VISION_TIMEOUT_MS`, `CLAUDE_VISION_MODEL`. Vertex/Gemini transport removed. |
| Article covers | **No model** — attributed og:image from a cited/evidence source (Imagen retired 2026-07) | `runner/article_art.js` (reuses `lib/lead_source_image` + `lib/source_image`) |
| Landmark hero art | **Gemini web app** via HelmStack browser session (signed-in Google account, no API key; Imagen retired 2026-07) | `tools/helmstack-social/src/gemini.js` engine ← `runner/landmark/art.js`; video generation scaffolded (needs Veo entitlement on the signed-in account). Chats self-delete after the bytes are extracted; backlog cleanup is `helmstack-social gemini purge` |
| Self-modification builder | **Claude CLI** (`BUILDER_BACKEND=claude`, `CLAUDE_BUILDER_MODEL`); Gemini 2.5 Pro Vertex fallback (`BUILDER_MODEL`) | `runner/builder_vertex.js` — routes like compose/think; falls back to Vertex on Claude failure |
| Website /api/ask endpoint | Gemini 2.5 Flash via Vertex | `web/lib/sebastianRespond.ts` (server-side site code) |

## 3. Cycle anatomy

**Pre-browse** (`runner/lib/pre_browse.js`, 17 runScript steps): fts_maintain →
topic summary (`scraper/query.js --hours 4`) → memory recall (FTS5+semantic) →
curiosity → search_curiosity → cluster_axes → rss_collect → comment_candidates →
discourse_scan → discourse_digest → external_source_discovery →
external_source_profile → source_selector → reading_queue → deep_dive_detector →
prefetch → source-label classification. (Old "14-step" count is stale.)

**Browse**: `single_pass_browse.js` (one Claude `composeJSON` call); writes
`browse_notes.md` + `ontology_delta.json`. Social pipeline (LinkedIn+X activity via
HelmStack) runs on BROWSE cycles (orchestrator.js:185).

**Evidence gates** (`runner/apply_ontology_delta.js`): source validity → per-session
source dedup → self-echo → claim fingerprint (SHA-1, 6h window, :409) → stance
validation (Claude, min conf 0.50, :69) → diversity constraint (dominant pole >70%
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
`scraper/analytics.js:136`) → TF-IDF novelty → LLM enrichment (post.gemini_meta
field name is legacy; enrichment runs on Claude via `_llmGenerate`) →
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
- **Quotation gate** `runner/lib/voice_filter.js:checkQuotations` — quoted spans of
  ≥`QUOTE_MIN_WORDS` (4) must appear verbatim in the quoted source; **fails CLOSED**
  (unrecoverable source ⇒ reject). Enforced at `runner/compose_quote.js`,
  `runner/voice_filter.js --quote` (pre- and post-rewrite), and before posting in
  `runner/lib/post_x_helmstack.js:runQuote` + `runner/post_quote.js`.
- **Source text lookup** `runner/lib/feed_lookup.js` — recovers a scraped post's own
  text by tweet ID from `state/feed_buffer.jsonl` via 1MB backward chunk scan,
  `MAX_SCAN` 64MB; `FEED_BUFFER_PATH` overrides the path for worktrees.
- **Re-quote dedupe** `runner/compose_quote.js:REQUOTE_WINDOW_DAYS` (30) — blocks
  re-quoting a source already in `posts_log.json` within the window (by tweet ID).
- **X engine**: `tools/helmstack-social` package (X + LinkedIn engines);
  `POST_BACKEND=helmstack` (.env:98). Tweets via CreateTweet GraphQL; quotes/replies
  via API; reposts via CreateRetweet; X Articles ported to HelmStack. Adapter:
  `runner/lib/post_x_helmstack.js` (keeps draft/result/attempt file contract).
  Legacy CDP scripts (`runner/post_tweet.js` etc.) remain as the non-helmstack
  backend path; live path is HelmStack.
- **X composer fallback** `tools/helmstack-social/src/x.js` — CreateTweet is refused
  often enough (`344` spurious "daily limit", `226` "looks automated", bare 200 with
  no id) that the UI path is load-bearing. Two traps, both fixed 2026-08-10:
  "Quote" **navigates** to `x.com/compose/post` (a status page's reply box is
  already `tweetTextarea_0`, so `_quoteViaComposer` gates on a `/compose/` path or
  dialog ancestor, not the bare selector); and `execCommand` selectAll+delete kills
  the next `Input.insertText`, so `_clearComposer` no-ops on an already-empty
  composer and `_insertVerified` un-does its warm-up probe with Backspaces.
- **Feed-engagement scoring is bounded**: `engage()` in both engines scores
  `scoreConcurrency` candidates at a time (default 3; `LI_SCORE_CONCURRENCY` in
  `runner/linkedin_engage.js`), because each score is a Claude CLI subprocess.
  Fanning all ~25 feed candidates out with `Promise.all` timed every call out and
  scored everything 0 — LinkedIn liked/commented nothing 2026-07-06 → 2026-08-10.
  Scorer timeout 90s (`linkedin_engage.js`, `lib/content_relevance.js`); regression
  test in `runner/tests/run_tests.js` → "LinkedIn engagement wiring".
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
  X-mention research is inline (blocking) by default; `X_ASYNC_RESEARCH=1`
  detaches it to `scraper/research_worker.js` (result at
  `state/research_results/<id>.json`, mention held as `status:"researching"`,
  picked up + posted on a later reply run, 6h TTL) so slow research doesn't
  starve simple mentions — off until dry-run validated (`reply.js:73-118`).
- **Stances** `runner/stance_scan.js` (daily, detached, `STANCE_SCAN_ENABLED`):
  RESOLVE up to 2 open stances via web search (was_right feeds ontology via
  `lib/stances` → ontology_delta); FORM 0-2 new stances on named, time-bound,
  contested events — principled stances must ground in real axes; taste stances
  capped at 2. Spectrum positions (event-scoped mini-axis), not binary.
  REFLECT: he decides per stance whether it earns a long-form **article** and/or
  **video** (neither is the expected answer), recorded on the stance as
  `media.{article,video}` via `lib/stances setMediaDecision`.
- **Stance article** `runner/stance_article.js` (daily, detached,
  `STANCE_ARTICLE_ENABLED`): drains the article queue his reflect pass created —
  researches the stance's own question (triage ON), composes to argue the side he
  committed to, publishes through the usual confidence + voice/fact-check gates
  via `researchToArticle`. No-ops when he asked for nothing.
- **Predictions** `runner/prediction_resolution.js` (self-throttled 1/day):
  resolves past-deadline predictions → correct|wrong|partial|expired; updates
  `prediction_log.jsonl` + `prediction_export.json`. Calibration
  (`runner/predictive_prompt.js` + belief_calibration feedback) injects measured
  hit-rate back into generation.
- **Daily stance video** `runner/stance_video.js` — the canonical chick
  character states his current position on camera, on location. Subject:
  newest open stance → strongest conviction → biggest axis move. Spoken line
  composed by the think backend, confidence-calibrated, passed through the
  shared outbound gates. Veo via the Gemini web engine; gated on account
  entitlement; output `state/videos/`, review via Telegram. Character: the canonical green-chick-with-pixel-shades
  (`CHARACTER_DIRECTIVE` in `runner/image_style.js`, reference asset
  `runner/assets/sebastian_character.png` — from his live LinkedIn avatar,
  operator decision 2026-07-20). **Voice** (operator decision 2026-08-05):
  Veo has no voice-lock (no API/seed/reference-audio — text prompt only), so
  the voice is `VOICE_DIRECTIVE` in `runner/image_style.js`, a fixed
  Filipino-accented-English description spliced into every prompt verbatim by
  `buildVideoPrompt()` — the brief LLM never authors the voice text, only
  topic/location/language/spoken_line. Language follows the same TAGALOG RULE
  as tweets/threads (`runner/lib/prompts/tweet.js`): PH-rooted subjects speak
  in Taglish, everything else in English, same accent either way.
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
Claude CLI (`claude -p`, local auth in `~/.claude`) · Vertex AI (workers/verify,
builder only — no runner path) ·
Arweave via Irys (Solana-funded; SOLANA_* keys) · Moltbook API
· Telegram bot API · Vercel deploy hook · Cloud Run worker URLs
(VERIFY_WORKER_URL, PUBLISH_WORKER_URL) · GitHub push per cycle.

Env vars in live `.env` (names only): see `.env.example`; notable current ones —
COMPOSE_BACKEND, CLAUDE_COMPOSE_MODEL, CLAUDE_ARTICLE_MODEL, CLAUDE_RETRIES,
CLAUDE_COMPOSE_TIMEOUT_MS, CLAUDE_THINK_TIMEOUT_MS, CLAUDE_BIN,
CLAUDE_CONFIG_DIR (runner's own Claude credential store — unset means every
`claude -p` spawn authenticates as the operator and shares one usage quota),
THINK_BACKEND, CLAUDE_THINK_MODEL, BUILDER_BACKEND, CLAUDE_BUILDER_MODEL,
CLAUDE_BUILDER_TIMEOUT_MS, POST_BACKEND=helmstack, HELMSTACK_URL,
HELMSTACK_AUTH_TOKEN, OUTBOX_X, X_AUTO_RESEARCH, X_DEEP_TREE, TWEET_START/END.

## 8. Dead / legacy code flags

- `runner/cdp.js` + CDP consumers (post_tweet/post_quote/post_thread/post_article/
  post_claims_thread/delete_tweet/post_and_pin/inject_cookies/check_notifs) —
  retained as legacy POST_BACKEND path + utilities; live path is HelmStack.
- `ai.openclaw.x-hunter` launchd agent — gateway removed from run.sh flow.
- `runner/vertex.js` / `runner/lib/gemini_agent.js` keep Gemini-era filenames;
  both are Claude-era shims now (compat shim / retired stub).
- `post.gemini_meta` field in scraper — legacy name for LLM enrichment.
- `scraper/embed.js` header still says text-embedding-004; embeddings are OFF.
- `BROWSE_MODEL`/`META_MODEL`/`POST_MODEL`/`OLLAMA_*`/`LOCAL_*` may linger in
  `.env` — inert, nothing reads them since the Claude-only cutover.
- Old ×0.025/0.98 confidence formula — superseded by belief_calibration.js
  (recalibrate_beliefs.js was the one-time migration).
