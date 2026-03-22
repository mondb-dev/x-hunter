# Orchestrator Migration Plan

Migrate `runner/run.sh` (1375-line bash monolith) to a Node orchestrator with A/B switching.
Path A = current bash. Path B = new Node. Both share the same state files, scripts, and agents.

---

## Principles

- **Incremental.** Each phase is independently shippable. No big-bang rewrite.
- **A/B at all times.** Every phase keeps path A functional. Rollback = one env var.
- **No new dependencies.** No frameworks, no task queues, no TypeScript build step. Plain Node + fs.
- **Same interface.** Both paths call the same `runner/*.js` scripts, read/write the same `state/` files.
  The orchestrator replaces the loop and prompt construction, not the actual work scripts.

---

## A/B Switch Mechanism

```bash
# run.sh top (after lock + env loading, before the while loop)
ORCHESTRATOR="${ORCHESTRATOR:-bash}"

if [ "$ORCHESTRATOR" = "node" ]; then
  echo "[run] Using Node orchestrator"
  exec node "$SCRIPT_DIR/orchestrator.js"
fi
```

- Default: bash (path A, unchanged behavior)
- `ORCHESTRATOR=node ./runner/run.sh` activates path B
- Add to `.env` when confident: `ORCHESTRATOR=node`
- Emergency rollback: `ORCHESTRATOR=bash ./runner/run.sh` or remove the line from `.env`

**⚠ `exec` replaces the bash process — bash traps will NOT fire when Node exits.**
The lock dir cleanup (`trap ... EXIT` at run.sh:38) and the scraper/stream stop trap
(run.sh:103) are lost after `exec`. The Node orchestrator MUST handle its own cleanup:

```js
// orchestrator.js top — replicate both bash traps
const LOCKDIR = path.join(PROJECT_ROOT, 'runner/run.lock');
const PIDFILE = path.join(PROJECT_ROOT, 'runner/run.pid');

function cleanup() {
  fs.rmSync(LOCKDIR, { recursive: true, force: true });
  fs.rmSync(PIDFILE, { force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  try { execSync(`bash "${PROJECT_ROOT}/scraper/stop.sh"`, { stdio: 'ignore' }); } catch {}
  try { execSync(`bash "${PROJECT_ROOT}/stream/stop.sh"`, { stdio: 'ignore' }); } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => process.emit('SIGINT'));
```

This is non-negotiable — without it, a crashed orchestrator leaves stale locks
and orphaned scraper/stream processes.

---

## Anatomy of run.sh (what we're replacing)

Accurate line-by-line map of the 1375-line file, grouped by concern:

| Lines | Concern | Complexity | Module target |
|-------|---------|------------|---------------|
| 1-91 | Shebang, lock, env, git, scraper/stream start | Low | stays in `run.sh` |
| 92-101 | Cycle constants (CYCLE, BROWSE_INTERVAL, TWEET_EVERY, QUOTE_OFFSET, hours, ports, log path) | Low | `lib/config.js` |
| 103 | Trap: stop scraper + stream on INT/TERM | Low | **orchestrator.js signal handlers** (see A/B switch section) |
| 106-115 | `reset_session()` — wipe agent JSONL + sessions.json | Medium | `lib/state.js` |
| 120-148 | `agent_run()` — background PID, 900s hard timeout, fast-fail retry | **High** | `lib/agent.js` |
| 150-198 | `restart_gateway()`, `start_browser()` — poll CDP/HTTP ports | **High** | `lib/browser.js` |
| 200-275 | `check_browser()`, `wait_for_browser_service()`, `ensure_browser()`, `check_and_fix_gateway_timeout()`, `clean_stale_locks()` | **High** | `lib/browser.js` (4 funcs) + `lib/state.js` (1 func) |
| 278-286 | caffeinate (macOS sleep prevention) | Low | `orchestrator.js` init block |
| 288-314 | While-loop top: pause sentinel, cycle counter, day number, cycle type determination | Low | `lib/cycle.js` |
| 316-334 | Hour gating, first-run detection (journal count), digest size check, heartbeat file | Low | `lib/cycle.js` |
| 339-357 | Scraper liveness (check 3 PID files, restart if dead) | Medium | `lib/health.js` |
| 359-406 | Browser health per cycle type (browse: CDP + gateway port separately; tweet/quote: ensure_browser), session reset, periodic gateway restart every 6 cycles, second lock sweep | **High** | `lib/browser.js` + orchestrator |
| 408-431 | First-run prompt (FIRSTMSG heredoc) + agent_run + gateway timeout check | Medium | `lib/prompts/first_run.js` |
| 434-488 | **Pre-browse pipeline**: FTS5 heal, query.js, recall.js, curiosity.js (every 12 cycles), cluster_axes.js (co-fires with curiosity), comment_candidates.js, discourse_scan.js, discourse_digest.js, reading_queue.js, deep_dive_detector.js (every 6 cycles), prefetch_url.js | **High** (11 scripts, conditional gating) | `lib/pre_browse.js` |
| 489-559 | State-loading block: 15+ vars from files + 1 inline `node -e` block (ontology axes); reading URL parsing + deep dive detection is bash grep/sed, journal check is bash `[ -f ]` | Medium | `lib/prompts/context.js` |
| 561-648 | Browse prompt (BROWSEMSG heredoc) | Medium | `lib/prompts/browse.js` |
| 649-666 | Browse agent_run + gateway timeout check + **journal crash-retry** (if journal missing after agent, retry once) | Medium | orchestrator loop |
| 669-731 | **Post-browse pipeline** (8 operations): cleanup_tabs, reading_queue --mark-done, apply_ontology_delta, detect_drift, journal commit decision (check porcelain → suppress failure → commit/push → archive + watchdog), moltbook heartbeat, retry pending checkpoint tweet, reply.js | **High** | `lib/post_browse.js` |
| 734-882 | Quote cycle: state loading (sprint context, quoted sources, digest, top axes with evidence), QUOTEMSG heredoc, state backup + chmod, agent_run, state restore, cleanup_tabs, voice_filter --quote, post_quote.js (3s sleep before CDP connect), watchdog, critique --quote | **High** | `lib/prompts/quote.js` + orchestrator |
| 884-961 | Tweet cycle pre-agent: browse_notes archive (append to browse_archive.md + trim to 6000 lines), state backup + chmod, state loading (browse_notes, memory_recall, discourse_digest, sprint context + active_plan fallback, axes, journal task), **browse_failed guard** (skip to SKIP if notes empty or contain failure phrases) | **High** | `lib/pre_tweet.js` + `lib/prompts/context.js` |
| 963-1071 | Tweet cycle agent: TWEETMSG heredoc, agent_run, crash-retry (if tweet_draft missing, retry once) | Medium | `lib/prompts/tweet.js` + orchestrator |
| 1073-1102 | Tweet post-agent part 1: cleanup_tabs, restore chmod, state restore, apply_ontology_delta, detect_drift | Medium | orchestrator |
| 1104-1143 | Tweet post-agent part 2: critique gate (critique_tweet.js → REJECT removes draft), voice_filter | Medium | `lib/post.js` (postRegularTweet) |
| 1145-1190 | Tweet post-agent part 3: post_tweet.js, watchdog, git commit/push + Vercel, archive.js, watchdog (journal), browse_notes clear, coherence critique | Medium | `lib/post_tweet.js` |
| 1193-1351 | **Daily maintenance block** (~158 lines, self-gates to 1×/24h): generate_daily_report, write_article, moltbook --post-article, ensure_browser, article tweet (2-attempt retry), generate_checkpoint, evaluate_vocation, update_bio, moltbook --post-checkpoint, checkpoint tweet (single-attempt), ponder, plan tweet, ponder tweet, moltbook --post-ponder, deep_dive, decision, sprint_manager, sprint_update, sprint tweet, moltbook --sprint-update, digest trim, log rotation (inode-preserving), git commit/push, Vercel deploy hook | **Very high** (19 scripts/operations + 5 tweet-posting subflows) | `lib/daily.js` (split into sub-functions) |
| 1353-1375 | Health watchdog (CYCLE_TYPE=HEALTH), wait for interval remainder, **post-sleep browser restart** (if elapsed > 2× interval, force restart Chrome) | Low | orchestrator loop |

**Key insight**: The heredocs (prompts) are only ~25% of the complexity. The other 75% is
the pre/post pipelines, per-cycle-type branching (browse vs tweet vs quote each have
distinct pre-agent, post-agent, and health-check flows), and the daily block.
Any migration plan that focuses only on prompts will underdeliver.

---

## File Structure (target)

```
runner/
  run.sh                    # ~80 lines: lock, env, A/B fork, scraper start
  orchestrator.js           # main loop (replaces run.sh lines 288-1375)
                            #   MUST include: signal handlers (lock/PID cleanup,
                            #   scraper/stream stop), caffeinate, post-sleep restart
  lib/
    config.js               # constants: intervals, ports, hours, paths
    cycle.js                # cycle type, day number, timing, pause sentinel,
                            #   heartbeat write, hour gating
    browser.js              # restart_gateway, start_browser, check_browser,
                            #   wait_for_browser_service, ensure_browser,
                            #   check_and_fix_gateway_timeout
                            #   (6 functions, ~130 lines — highest-risk port)
    agent.js                # agent_run wrapper: background PID, 900s timeout,
                            #   fast-fail retry, exit code propagation
    state.js                # backup/restore JSON, validatePostsLog, clean_stale_locks,
                            #   reset_session, chmod dance for posts_log
    pre_browse.js           # 11-script pipeline: FTS5, query, recall, curiosity,
                            #   cluster_axes, comment_candidates, discourse_scan,
                            #   discourse_digest, reading_queue, deep_dive_detector,
                            #   prefetch_url (conditional logic preserved)
    pre_tweet.js            # tweet cycle pre-agent: browse_notes archive (append +
                            #   trim to 6000 lines), browse_failed guard (skip if
                            #   notes empty or contain failure phrases)
    post_browse.js          # 9-operation post-agent block: cleanup_tabs, reading_queue
                            #   --mark-done, apply_delta, detect_drift, journal commit
                            #   (with failure suppression + archive + watchdog),
                            #   moltbook heartbeat, moltbook --post-checkpoint retry
                            #   (if checkpoint_pending), checkpoint tweet retry, reply.js
    post_tweet.js           # tweet post-agent: cleanup_tabs, state restore, ontology
                            #   delta, drift, critique gate, voice filter, post_tweet.js,
                            #   watchdog, git commit/push, archive, watchdog (journal),
                            #   browse_notes clear, coherence critique
    post.js                 # 4 posting pipelines (NOT unified — genuinely different):
                            #   postRegularTweet: critique → voice_filter → post_tweet.js
                            #   postQuoteTweet: voice_filter(--quote) → 3s sleep → post_quote.js
                            #   postLinkTweet: 2-attempt retry + ensure_browser between
                            #   postSimpleTweet: single-attempt, no filter
    git.js                  # commit, push, Vercel deploy hook
    daily.js                # daily maintenance coordinator (19 ops + 5 tweet subflows):
                            #   - reports: belief report, article, article tweet (2-attempt)
                            #   - checkpoint: generate, vocation, bio, moltbook, tweet (1-attempt)
                            #   - ponder: ponder.js, plan tweet, ponder tweet, moltbook, deep_dive, decision
                            #   - sprint: sprint_manager, sprint_update, sprint tweet, moltbook
                            #   - housekeeping: digest trim, log rotation (inode-preserving), daily commit
    health.js               # scraper liveness (3 PID checks), FTS5 integrity, watchdog
    log.js                  # structured logging ([run], [browse], [tweet], etc.)
    prompts/
      context.js            # reads ALL state files into ctx object (absorbs the 15+
                            #   file loads AND all 5 inline node -e blocks across cycle types:
                            #   ontology axes (browse+tweet, same logic), quoted_sources dedup
                            #   (quote), top_axes with evidence (quote), active_plan fallback
                            #   (tweet) — 4 distinct patterns)
      browse.js             # returns browse prompt string from ctx
      tweet.js              # returns tweet prompt string from ctx
      quote.js              # returns quote prompt string from ctx
      first_run.js          # returns first-ever-cycle prompt from ctx
```

---

## Phases

### Phase 0: Prep (no behavior change) ✅ DONE

**Goal:** Set up A/B switch point and file structure. Path A still runs everything.

**Status:** Completed 2026-03-21. A/B switch in run.sh (line ~104), orchestrator.js stub
with signal handlers, config.js with all constants + paths.

1. Add the `ORCHESTRATOR` env var fork to `run.sh` (6 lines, after env load, before while loop)
2. Create `runner/lib/` directory
3. Create `runner/orchestrator.js` as a stub that logs "Node orchestrator not yet implemented" and exits
4. Create `runner/lib/config.js` — extract all constants from run.sh top:
   ```js
   module.exports = {
     BROWSE_INTERVAL: 1800,
     TWEET_EVERY: 6,
     QUOTE_OFFSET: 3,
     TWEET_START: 7,
     TWEET_END: 23,
     CURIOSITY_EVERY: 12,
     GATEWAY_PORT: 18789,
     CDP_PORT: 18801,
     AGENT_START_DATE: '2026-02-23',
     PROJECT_ROOT: path.resolve(__dirname, '../..'),
     // ... paths derived from PROJECT_ROOT
   };
   ```

**Test:** `ORCHESTRATOR=node ./runner/run.sh` exits cleanly with message.
`./runner/run.sh` runs path A unchanged.

---

### Phase 1: Extract Prompts + Context Loader ✅ DONE

**Goal:** Move the four heredoc prompts AND all state-loading logic into JS modules.
This is the highest-value change — eliminates bash heredoc escaping issues and makes
prompts editable with proper string handling.

**Status:** Completed 2026-03-21. All 5 prompt modules created, run.sh heredocs replaced
with node CLI calls. 397 lines removed (1386 → 989). Parity test: 5/5 data formatting
tests pass (currentAxes, topAxes, quotedSources, activePlanContext — exact match).
**Not yet deployed to VM** — local only, needs push.

**Critical: `context.js` must absorb the state-loading blocks, not just the heredocs.**

The current bash loads ~15 state variables via file reads and inline `node -e` snippets
(e.g., ontology axes formatting, reading queue URL parsing, quoted sources dedup).
All of this moves into `context.js`:

```js
// runner/lib/prompts/context.js
module.exports = function loadContext(opts) {
  // File reads (currently done via cat/tail + sed in bash):
  //   browse_notes, topic_summary, feed_digest, critique, curiosity_directive,
  //   comment_candidates, discourse_digest, sprint_context, reading_url
  //
  // Node -e blocks (currently inline in run.sh):
  //   - ontology axes formatting (browse + tweet variants)
  //   - quoted_sources dedup from posts_log.json
  //   - top belief axes with evidence for quote prompt
  //   - active_plan fallback chain
  //
  // Reading queue URL parsing + deep dive vs article detection
  //
  // Returns plain ctx object — used by all prompt builders
};
```

Each prompt module exports a function AND is callable as CLI:

```js
// runner/lib/prompts/browse.js
module.exports = function buildBrowsePrompt(ctx) { ... };
if (require.main === module) {
  const loadContext = require('./context');
  console.log(module.exports(loadContext({ type: 'browse' })));
}
```

**Phase 1 can be used from BOTH paths:**
- Path A (bash): replace heredoc with `AGENT_MSG=$(node runner/lib/prompts/browse.js)`
- Path B (node): `require('./lib/prompts/browse')(ctx)`

**Deliverables:**
1. `runner/lib/prompts/context.js` — reads state files + replaces all inline `node -e` blocks
2. `runner/lib/prompts/browse.js` — browse cycle prompt
3. `runner/lib/prompts/tweet.js` — tweet cycle prompt
4. `runner/lib/prompts/quote.js` — quote cycle prompt
5. `runner/lib/prompts/first_run.js` — bootstrap prompt
6. Update `run.sh` to call `node runner/lib/prompts/<type>.js` instead of inline heredocs

**Test:** Run path A for 2-3 full cycles (browse + tweet + quote). Diff generated prompts
char-by-char against bash-generated ones. Agent behavior should be identical.

---

### Phase 2: Extract Browser + State Helpers ✅ DONE

**Goal:** Port the 6 browser functions and state management into Node modules.

**Status:** Completed 2026-03-22. Three modules created:
- `lib/browser.js` (8 exports): restartGateway, startBrowser, checkBrowser, waitForBrowserService,
  ensureBrowser, checkAndFixGatewayTimeout, countGatewayErrLines, checkGatewayPort.
  All poll intervals, timeouts, and escalation steps match bash originals exactly.
- `lib/state.js` (5 exports): resetSession, cleanStaleLocks, backupState, restoreIfCorrupt,
  chmodPostsLog. Includes posts_log entry count validation on restore.
- `lib/agent.js` (1 export): agentRun with 900s hard-kill timeout + <45s fast-fail retry.
  Uses synchronous child_process polling to match bash blocking behavior.
All modules tested locally — load OK, state functions verified with real files.
Modules are standalone (not wired into run.sh) — bash path A unchanged. Ready for Phase 5.

**⚠ This is the highest-risk phase.** The browser recovery logic (lines 151-286) is the most
brittle part of the codebase. It has been tuned through production failures. Port carefully.

**runner/lib/browser.js** (6 functions, ~170 lines of bash):

| Function | What it does | Risk notes |
|----------|-------------|------------|
| `restartGateway()` | pkill openclaw-gateway, start, poll HTTP health 15×2s | Must preserve the direct pkill (avoids openclaw's 60s internal timeout) |
| `startBrowser()` | stop/start profile, poll CDP 15×2s, create tab if zero | The zero-tab detection + CDP PUT to create a tab is load-bearing |
| `checkBrowser()` | calls browser_check.js (CDP `/json/version` HTTP check, 5s timeout) | Lightweight HTTP check, NOT a page load test. Can inline in Node. |
| `ensureBrowser()` | 3-attempt retry: check → restart gateway → start browser | The 3-layer escalation sequence matters |
| `waitForBrowserService(timeout)` | poll until agent tool works | Distinct from CDP check — tests openclaw's browser tool layer |
| `checkAndFixGatewayTimeout(before)` | diff gateway error log lines | Must capture line count BEFORE agent_run, diff AFTER |

**runner/lib/state.js:**
- `backupState(files)` — copy .json → .json.bak before agent runs
- `restoreIfCorrupt(files)` — validate JSON, restore from .bak if malformed
- `validatePostsLog()` — check entry count didn't shrink (agent sometimes wipes it)
- `cleanStaleLocks()` — remove JSONL lock files with dead PIDs
- `resetSession(agentName)` — wipe JSONL + sessions.json for an agent
- `chmodPostsLog(mode)` — the read-only/read-write dance during agent runs

**Test:** Deliberately kill Chrome during a browse cycle. Verify recovery matches bash.
Deliberately corrupt state/ontology.json. Verify restore works.

---

### Phase 2b: Extract Pre/Post Pipelines ✅ DONE

**Goal:** Move the pre-browse, pre-tweet, and post-browse sequences into modules.

**Status:** Completed 2026-03-22. Three pipeline modules created, all tests passing (9/9).
Standalone modules — not wired into run.sh. Ready for Phase 5 orchestrator.

These are the "missing middle" — the orchestration logic between prompt construction and
agent invocation that the prompts alone don't cover.

**runner/lib/pre_browse.js** (lines 434-488, 11 ordered script invocations):

```js
module.exports = async function preBrowse(cycle, config) {
  // 1. FTS5 integrity check + rebuild if corrupted
  // 2. query.js --hours 4 (topic summary + memory index)
  // 3. recall.js (keyword-driven, from topic_summary top 3)
  // 4. curiosity.js (every CURIOSITY_EVERY cycles)
  // 5. cluster_axes.js (co-fires with curiosity)
  // 6. comment_candidates.js
  // 7. discourse_scan.js → discourse_anchors.jsonl
  // 8. discourse_digest.js → discourse_digest.txt
  // 9. reading_queue.js (emit reading URL for this cycle)
  // 10. deep_dive_detector.js (every 6 cycles)
  // 11. prefetch_url.js (pre-load curiosity URL in browser)
};
```

**runner/lib/post_browse.js** (lines 669-731, 9 top-level operations):

```js
module.exports = async function postBrowse(cycle, config) {
  // 1. cleanup_tabs.js (close excess Chrome tabs)
  // 2. reading_queue.js --mark-done (if reading URL was set)
  // 3. apply_ontology_delta.js
  // 4. detect_drift.js
  // 5. Journal commit decision (4 sub-steps):
  //    a. Check git porcelain for new journal file
  //    b. Suppress failure journals (grep for "browser control service",
  //       "browser.*unavailable", etc. → git checkout or rm)
  //    c. git add journals/ state/ → commit → push if valid
  //    d. archive.js + CYCLE_TYPE=JOURNAL watchdog.js if committed
  // 6. moltbook.js --heartbeat
  // 7. moltbook.js --post-checkpoint (if checkpoint_pending flag exists;
  //    retries each browse cycle until Moltbook post succeeds)
  // 8. Retry pending checkpoint tweet (if checkpoint_result.txt exists:
  //    read URL+title, format draft, post_tweet.js, rm on success)
  // 9. reply.js (process pending replies)
};
```

**runner/lib/pre_tweet.js** (lines 884-961, tweet cycle pre-agent):

```js
module.exports = async function preTweet(cycle, config) {
  // 1. Archive browse_notes.md → append to browse_archive.md with cycle header
  // 2. Trim browse_archive.md to 6000 lines (tail -n 5000 on overflow)
  // 3. Browse-failed guard: if browse_notes < 80 chars OR contains failure
  //    phrases ("browser control service", "no new observations", etc.)
  //    → write "SKIP" to tweet_draft.txt and return false (skip agent)
  // Returns true if agent should run, false if skipped
};
```

**Test:** Run 3 browse cycles. Verify all 11 pre-browse scripts fire in correct order
with correct conditional gating. Verify post-browse journal suppression still works.
Test pre_tweet by emptying browse_notes.md — verify "SKIP" is written, no agent invoked.

---

### Phase 3: Extract Post & Git Helpers ✅ DONE

**Goal:** Unify the 6+ tweet-posting patterns into composable functions.

The current codebase has **4 distinct posting pipelines** (not a common tail — each is different):

| Flow | Critique? | Voice filter? | Retry? | Rate-limit gap? | Post-post? |
|------|-----------|---------------|--------|-----------------|------------|
| Regular tweet | Yes (critique_tweet.js → REJECT removes draft) | Yes (voice_filter.js) | Agent crash-retry only | No | watchdog, coherence critique |
| Quote tweet | No | Yes (--quote) | No | 3s pre-CDP sleep | watchdog, critique --quote |
| Article tweet | No | No | **2-attempt** with ensure_browser + 20s wait between | Yes (60s after) | — |
| Checkpoint/plan/ponder/sprint tweet | No | No | **Single-attempt** | Yes (60s after, except sprint: none) | — |

Note: the article tweet is the only link-tweet with a retry loop. All other daily-block
tweets are single-attempt (failures are logged but not retried within the same daily block).

**runner/lib/post.js:**
```js
// NOT one function with a type flag — these are genuinely different pipelines.
module.exports = {
  postRegularTweet,   // critique → journal URL fix → voice_filter → post_tweet.js
  postQuoteTweet,     // voice_filter(--quote) → post_quote.js
  postLinkTweet,      // post_tweet.js with 2-attempt retry + ensure_browser
  postSimpleTweet,    // post_tweet.js, no retry, no filter (plan/ponder announcements)
};
```

**runner/lib/git.js:**
```js
module.exports = {
  commitAndPush,       // git add, commit, push with configurable paths
  triggerVercelDeploy,
};
```

**Test:** Trigger each posting type. Verify critique gate fires only for regular tweets.
Verify voice filter fires for tweets + quotes but not link/simple tweets.

---

### Phase 4: Extract Daily Block

**Goal:** Move the 158-line daily maintenance block into a structured module.

The daily block is the second-largest concern after the main loop. It runs 19 operations
in sequence with 5 embedded tweet-posting subflows and self-gates to once per 24h.

**runner/lib/daily.js:**
```js
module.exports = async function runDaily(config) {
  // Self-gate: check last_daily_at.txt, skip if < 24h elapsed
  
  await reports(config);     // belief report, article, article tweet
  await checkpoint(config);  // generate, vocation, bio, moltbook, checkpoint tweet
  await ponder(config);      // ponder, deep_dive, decision, ponder tweet, moltbook
  await sprint(config);      // sprint_manager, sprint_update, sprint tweet, moltbook
  await housekeeping(config);// digest trim, log rotation, daily git commit, Vercel
  
  // Mark completion time
};

async function reports(config) {
  // generate_daily_report.js
  // write_article.js → moltbook --post-article
  // sleep 15 → ensure_browser (daily block needs browser for tweets)
  // Tweet article link (2-attempt retry with ensure_browser + 20s wait between, 60s gap after)
  // ⚠ Article tweet is the ONLY daily tweet with a retry loop
}

async function checkpoint(config) {
  // generate_checkpoint.js → evaluate_vocation.js → update_bio.js
  // moltbook --post-checkpoint
  // Tweet checkpoint link (SINGLE attempt, 60s gap) — no retry
}

async function ponder(config) {
  // ponder.js
  // plan_tweet.txt → tweet_draft.txt → post_tweet.js (single attempt, 60s gap)
  // ponder_tweet.txt → tweet_draft.txt → post_tweet.js (single attempt, 10s gap)
  //   + touch ponder_post_pending flag
  // moltbook --post-ponder (retries every daily cycle until flag cleared)
  // deep_dive.js → decision.js (both self-gating on timing)
}

async function sprint(config) {
  // sprint_manager.js → sprint_update.js
  // Sprint progress tweet + moltbook --sprint-update
}

async function housekeeping(config) {
  // Trim digest to 3000 lines
  // Rotate runner.log (5000) + scraper.log (3000) — inode-preserving
  // git add/commit/push daily outputs
  // Vercel deploy hook
}
```

**Test:** Trigger daily block manually. Verify all 19 operations and 5 tweet-posting
subflows fire correctly. Verify article tweet retries on failure (2-attempt loop).
Verify log rotation preserves inodes (critical for running shell).

---

### Phase 5: Build the Orchestrator

**Goal:** Write `orchestrator.js` — the main loop that composes all extracted modules.

```js
// ── Init: signal handlers, caffeinate, config ───────────────────────────
// See A/B switch section for required signal handlers (lock cleanup,
// scraper/stream stop). These are NON-OPTIONAL — exec kills bash traps.
setupSignalHandlers();
if (process.platform === 'darwin') spawnCaffeinate();

let cycle = 0;

while (true) {
  // ── Pause sentinel ──────────────────────────────────────────────────
  if (shouldPause()) { await sleep(60_000); continue; }

  cycle++;
  const cycleStart = Date.now();
  const { type, today, now, hour, dayNumber } = determineCycleType(cycle);
  writeHeartbeat(cycle, type, today, now);

  // ── Pre-cycle (all cycle types) ─────────────────────────────────────
  cleanStaleLocks();
  checkScraperLiveness();

  // ── Browser health (DIFFERENT per cycle type) ───────────────────────
  if (type === 'browse') {
    // Check CDP AND gateway port separately (not ensure_browser — lighter)
    if (!checkBrowser()) { restartGateway(); startBrowser(); await sleep(15_000); }
    else if (!checkGatewayPort()) { restartGateway(); await sleep(10_000); }
  }
  if (type === 'tweet' || type === 'quote') {
    resetSession('x-hunter-tweet');
    ensureBrowser();  // full 3-attempt retry
  }

  // ── Periodic gateway restart (every 6 cycles) ──────────────────────
  if (cycle % 6 === 0) {
    resetSession('x-hunter');
    restartGateway(); startBrowser();
    if (!await waitForBrowserService(30)) {
      if (type === 'tweet' || type === 'quote') type = 'browse';  // downgrade
    }
  }
  cleanStaleLocks();  // second sweep after any gateway/browser restart

  // ── First-run detection ─────────────────────────────────────────────
  const journalCount = countJournals();
  if (journalCount === 0) {
    const prompt = buildFirstRunPrompt({ today, now });
    const gwBefore = countGatewayErrLines();
    agentRun({ agent: 'x-hunter', message: prompt, thinking: 'high' });
    checkAndFixGatewayTimeout(gwBefore);
    // Skip to daily + sleep
  }

  // ── BROWSE cycle ────────────────────────────────────────────────────
  else if (type === 'browse') {
    await preBrowse(cycle, config);   // 11 scripts
    const ctx = loadContext({ type: 'browse', cycle, dayNumber, today, now, hour });
    const prompt = buildBrowsePrompt(ctx);
    const gwBefore = countGatewayErrLines();
    const journalBefore = checkJournalExists(today, hour);
    agentRun({ agent: 'x-hunter', message: prompt, thinking: 'low' });
    checkAndFixGatewayTimeout(gwBefore);
    // Retry if journal missing
    if (!journalBefore && !checkJournalExists(today, hour)) {
      await sleep(5_000);
      agentRun({ agent: 'x-hunter', message: prompt });
    }
    await postBrowse(cycle, config);  // 8 operations
  }

  // ── QUOTE cycle ─────────────────────────────────────────────────────
  else if (type === 'quote') {
    const ctx = loadContext({ type: 'quote', cycle, dayNumber, today, now });
    const prompt = buildQuotePrompt(ctx);
    backupState(['posts_log', 'ontology', 'belief_state']);
    chmodPostsLog('444');
    agentRun({ agent: 'x-hunter', message: prompt, thinking: 'low' });
    chmodPostsLog('644');
    restoreIfCorrupt(['posts_log', 'ontology', 'belief_state']);
    // Post-quote: cleanup_tabs → voice_filter --quote → 3s sleep → post_quote.js
    //   → watchdog QUOTE → critique --quote
    await postQuotePipeline(cycle, config);
  }

  // ── TWEET cycle ─────────────────────────────────────────────────────
  else if (type === 'tweet') {
    const shouldRun = await preTweet(cycle, config);  // archive notes + browse_failed guard
    if (shouldRun) {
      const ctx = loadContext({ type: 'tweet', cycle, dayNumber, today, now, hour });
      const prompt = buildTweetPrompt(ctx);
      backupState(['posts_log', 'ontology', 'belief_state']);
      chmodPostsLog('444');
      agentRun({ agent: 'x-hunter-tweet', message: prompt, thinking: 'low' });
      // Retry if tweet_draft missing
      if (!fileExists('state/tweet_draft.txt')) {
        await sleep(5_000);
        agentRun({ agent: 'x-hunter-tweet', message: prompt });
      }
    }
    chmodPostsLog('644');
    restoreIfCorrupt(['posts_log', 'ontology', 'belief_state']);
    // Post-tweet: cleanup_tabs → ontology delta → drift → critique gate →
    //   voice filter → post → watchdog → commit/push → archive → watchdog →
    //   clear notes → coherence critique
    await postTweetPipeline(cycle, config);
  }

  // ── Daily maintenance (self-gated, runs after ANY cycle type) ───────
  await runDaily(config);

  // ── Wait remainder of interval + post-sleep detection ───────────────
  const elapsed = Date.now() - cycleStart;
  const wait = config.BROWSE_INTERVAL * 1000 - elapsed;
  if (wait > 0) {
    await sleep(wait);
  } else if (elapsed > config.BROWSE_INTERVAL * 2000) {
    // Mac woke from sleep — force browser restart
    await restartBrowserAfterSleep();
  }
}
```

This is a **direct port** — same sequence, same scripts, same state files, same
branching logic. The pseudocode above captures every significant decision point
in the current bash. No new logic, no "improvements."

**Test:** Run `ORCHESTRATOR=node ./runner/run.sh` for a full day with monitoring.
Compare journals, posts_log, ontology changes against a typical bash day.

---

### Phase 6: Harden & Default

**Goal:** After 3-5 days of clean path B operation, make Node the default.

1. Change default: `ORCHESTRATOR="${ORCHESTRATOR:-node}"`
2. Keep path A intact — no code removed, just no longer default
3. Add structured logging to orchestrator (JSON lines to `runner/orchestrator.log`)
4. Add basic health metrics: cycle duration, agent exit codes, post success rate

**Later (optional):**
- Remove path A after 2+ weeks of clean path B operation
- Add unit tests for cycle.js, prompts, state.js
- Convert remaining bash helpers to JS (scraper/start.sh, stream/start.sh currently fine)

---

## What NOT to change

- **scraper/start.sh** — independent, clean, stays as bash
- **stream/start.sh** — independent, stays as bash
- **All runner/*.js scripts** — post_tweet, post_quote, archive, critique, voice_filter,
  watchdog, etc. are the workers. They stay.
- **State file formats** — no schema changes. orchestrator.js reads/writes the same files.
- **Agent configurations** — x-hunter and x-hunter-tweet agent configs are untouched.
- **Singleton lock** — stays in run.sh (bash), fires before the A/B fork.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `exec` kills bash traps — lock/PID/scraper orphaned | **Critical** | Phase 5: orchestrator.js MUST implement signal handlers before anything else. Test: kill -TERM the Node process, verify lock dir removed and scraper stopped. |
| Prompt regression (subtle wording change breaks agent behavior) | High | Phase 1 test: diff generated prompts char-by-char against bash originals. Apostrophes and backtick escaping are the main risk — bash `sed "s/\`/'/g"` must be replicated or removed. |
| Browser recovery behaves differently | **Critical** | Phase 2 test: deliberately kill Chrome, verify same recovery sequence. Port each function 1:1 with matching poll intervals. Pay special attention to the browse-vs-tweet/quote health check divergence. |
| `agent_run` timeout/retry semantics change | High | Phase 2: preserve background PID + 900s kill + fast-fail retry exactly. Unit test: agent exits in 30s with error → must retry. Agent runs 901s → must be killed. |
| Browse_failed guard missing in port | High | Phase 2b: pre_tweet.js must check browse_notes length AND grep for failure phrases. Without this gate, the tweet agent gets invoked on empty notes and hallucinates. |
| State corruption during switchover | Low | Both paths are stateless between cycles — switch at any cycle boundary is safe |
| Daily block tweets fire out of order or missing | Medium | Phase 4: test all 5 tweet subflows independently. The 60s rate-limit gaps and the article-only retry loop must be preserved exactly. |
| Pre-browse pipeline ordering changes | Medium | Phase 2b: scripts must fire in same order — curiosity gates cluster_axes, deep_dive_detector gates on cycle%6==0 |
| Log rotation breaks running shell | Low | Phase 4: preserve cp+truncate inode pattern (don't use mv). In Node, use fs.readFileSync + fs.writeFileSync to overwrite in-place. Test with active tail -f. |
| Emergency at 3am, need to rollback fast | Low | `ORCHESTRATOR=bash` in .env, restart. 5 seconds. |

---

## Estimated Effort & Dependencies

```
Phase 0  ──────────────── (stub + config)
  │
  ├── Phase 1 ─────────── (prompts + context loader)
  │
  ├── Phase 2 ─────────── (browser + state — HIGHEST RISK)
  │     │
  │     └── Phase 2b ──── (pre_browse + pre_tweet + post_browse)
  │           │
  │           └── Phase 3  (post_tweet pipeline + post.js + git)
  │                 │
  │                 └── Phase 4  (daily block — 19 ops + 5 tweet subflows)
  │                       │
  └───────────────────────┘
                          │
                    Phase 5 ────── (orchestrator loop + signal handlers — composes all)
                          │
                    Phase 6 ────── (default switch — after 3-5 day soak)
```

| Phase | Scope | Lines of bash replaced | Est. effort | Depends on |
|-------|-------|----------------------|-------------|-----------|
| 0 | A/B switch + stub + config.js | 0 (additive) | 1 hour | nothing | **✅ DONE** |
| 1 | Prompts + context loader | ~400 (4 heredocs + 15 state vars + 5 node -e blocks) | 4-6 hours | Phase 0 | **✅ DONE** |
| 2 | Browser + state helpers | ~180 (6 browser funcs + 5 state funcs) | 6-8 hours | Phase 0 | **✅ DONE** |
| 2b | Pre/post pipelines (pre_browse, pre_tweet, post_browse) | ~140 (11 + 3 + 8 operations) | 4-5 hours | Phase 2 | **✅ DONE** |
| 3 | Post pipelines (post_tweet, post.js) + git | ~120 (4 posting flows + tweet post-pipeline + git) | 3-4 hours | Phase 2 | **✅ DONE** |
| 4 | Daily block | ~158 (19 ops + 5 tweet subflows) | 4-5 hours | Phase 3 |
| 5 | Orchestrator loop + signal handlers | ~90 (main loop + cleanup + caffeinate + post-sleep) | 3-4 hours | Phases 1-4 |
| 6 | Default switch + logging | 0 (flag flip + additive) | 1 hour | Phase 5 + 3-5 day soak |
| **Total** | | **~1090 lines** | **26-34 hours** | |

Phases 1 and 2 can proceed in parallel after Phase 0.
Phase 2b depends on Phase 2 (needs browser.js for ensure_browser calls in post_browse).
Phase 3 depends on Phase 2 (post.js needs ensure_browser for article tweet retry).
Phase 5 composes everything + adds signal handlers (critical — see A/B switch section).
Phase 6 is a flag flip after confidence builds.
