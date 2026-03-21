#!/bin/bash
# runner/run.sh — continuous agent loop
#
# Three-tier architecture:
#   Scraper loop (every 10 min, background): collect.js scrapes X feed via CDP,
#                                            scores posts, writes feed_digest.txt
#   Browse cycle (every 30 min, AI):        reads feed_digest.txt, takes notes,
#                                            updates ontology + trust_graph
#   Tweet cycle  (every 6th = 2 hrs, AI):  synthesizes notes, journals, tweets,
#                                            git push
#
# Press Ctrl+C to stop.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Singleton guard — atomic lock directory (mkdir is POSIX-atomic) ───────────
# mkdir succeeds only once even under concurrent starts, preventing duplicate runners.
LOCKDIR="$PROJECT_ROOT/runner/run.lock"
PIDFILE="$PROJECT_ROOT/runner/run.pid"

if mkdir "$LOCKDIR" 2>/dev/null; then
  echo $$ > "$LOCKDIR/pid"
else
  OLD_PID=$(cat "$LOCKDIR/pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[run] Another instance is already running (pid $OLD_PID). Exiting."
    exit 1
  fi
  # Stale lock (process died without cleanup) — reclaim it
  echo "[run] Removing stale lock (pid ${OLD_PID:-unknown} is dead)..."
  rm -rf "$LOCKDIR"
  mkdir "$LOCKDIR" || { echo "[run] Failed to acquire lock. Exiting."; exit 1; }
  echo $$ > "$LOCKDIR/pid"
fi
# Keep run.pid for external monitoring compatibility
echo $$ > "$PIDFILE"
trap 'rm -rf "$LOCKDIR"; rm -f "$PIDFILE"' EXIT

# Kill any stale scraper loops left over from prior runner (trap does not fire on SIGKILL)
bash "$PROJECT_ROOT/scraper/stop.sh" 2>/dev/null || true

# ── Load env ──────────────────────────────────────────────────────────────────
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a && source "$PROJECT_ROOT/.env" && set +a
else
  echo "[run] ERROR: .env not found."
  exit 1
fi

# ── Confirm gateway is running ────────────────────────────────────────────────
if ! openclaw gateway status &>/dev/null; then
  echo "[run] Gateway not running. Starting..."
  openclaw gateway start
  sleep 3
fi

# ── Ensure browser is running ─────────────────────────────────────────────────
echo "[run] Starting x-hunter browser..."
openclaw browser --browser-profile x-hunter start
sleep 2

# ── Configure git identity ────────────────────────────────────────────────────
git -C "$PROJECT_ROOT" config user.name "${GIT_USER_NAME:-x-hunter-agent}"
git -C "$PROJECT_ROOT" config user.email "${GIT_USER_EMAIL:-agent@x-hunter.local}"
if [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_REPO" ]; then
  # Use credential helper so the token is never written into the git remote URL
  git -C "$PROJECT_ROOT" config credential.helper \
    '!f() { echo "username=x-token"; echo "password='"$GITHUB_TOKEN"'"; }; f'
  git -C "$PROJECT_ROOT" remote set-url origin "https://github.com/${GITHUB_REPO}.git" 2>/dev/null || true
fi

# ── Start pump.fun stream (if key is configured) ──────────────────────────────
if [ -n "$PUMPFUN_STREAM_KEY" ]; then
  echo "[run] Starting pump.fun stream..."
  bash "$PROJECT_ROOT/stream/start.sh"
else
  echo "[run] PUMPFUN_STREAM_KEY not set — skipping stream"
fi

# ── Start scraper loop (background) ──────────────────────────────────────────
echo "[run] Starting scraper loop..."
bash "$PROJECT_ROOT/scraper/start.sh"

# ── Three-tier agent cycle loop ───────────────────────────────────────────────
# Browse cycle: every 20 minutes (AI reads pre-scraped digest)
# Quote cycle:  every 3rd browse cycle (every 1 hour, midpoint between tweets)
# Tweet cycle:  every 6th browse cycle (every 2 hours, active hours only)
# Clear stale curiosity directive from any previous run so the agent never acts on old data
rm -f "$PROJECT_ROOT/state/curiosity_directive.txt"

CYCLE=0
BROWSE_INTERVAL=1800  # 30 minutes in seconds
TWEET_EVERY=6         # tweet on cycles 6, 12, 18, ... (every 2 hours)
QUOTE_OFFSET=3        # quote-tweet on cycles 3, 9, 15, ... (midpoint between tweets)
TWEET_START=7         # earliest hour to post original tweets (0-23 UTC)
TWEET_END=23          # latest hour exclusive
CURIOSITY_EVERY=12    # refresh curiosity directive every ~4h (was 4)
GATEWAY_PORT=18789    # openclaw gateway WebSocket/HTTP port
CDP_PORT=18801        # Chrome DevTools Protocol port
GATEWAY_ERR_LOG="$HOME/.openclaw-x-hunter/logs/gateway.err.log"  # x-hunter gateway error log

trap 'echo "[run] Stopping..."; bash "$PROJECT_ROOT/scraper/stop.sh" 2>/dev/null; bash "$PROJECT_ROOT/stream/stop.sh" 2>/dev/null; exit 0' INT TERM

# ── Orchestrator A/B switch ───────────────────────────────────────────────────
# Set ORCHESTRATOR=node in .env (or env) to use the Node orchestrator.
# Default: bash (this file continues as path A). Rollback: ORCHESTRATOR=bash
ORCHESTRATOR="${ORCHESTRATOR:-bash}"
if [ "$ORCHESTRATOR" = "node" ]; then
  echo "[run] Using Node orchestrator (path B)"
  exec node "$SCRIPT_DIR/orchestrator.js"
  # exec replaces this process — nothing below runs when ORCHESTRATOR=node
fi

# ── Session reset helper ──────────────────────────────────────────────────────
reset_session() {
  local DIR="$HOME/.openclaw/agents/$1/sessions"
  # Delete all JSONL files (not .bak) and wipe sessions.json so gateway starts truly fresh
  local FOUND=0
  for f in "$DIR"/*.jsonl; do
    [ -f "$f" ] && rm -f "$f" && FOUND=1
  done
  echo "{}" > "$DIR/sessions.json"
  [ "$FOUND" -eq 1 ] && echo "[run] $1 session reset (context flush)"
}

# Run openclaw agent with a hard 15-minute timeout to prevent multi-hour hangs
# (openclaw can loop on gateway reconnect indefinitely after embedded completes)
# If the agent exits in under 45s (likely a transient model/gateway error), retry once.
agent_run() {
  local attempt=0
  while [ $attempt -lt 2 ]; do
    attempt=$(( attempt + 1 ))
    local start_ts elapsed
    start_ts=$(date +%s)
    openclaw agent "$@" &
    local PID=$!
    elapsed=0
    while kill -0 "$PID" 2>/dev/null; do
      sleep 5
      elapsed=$(( elapsed + 5 ))
      if [ "$elapsed" -ge 900 ]; then
        echo "[run] WARNING: openclaw agent exceeded 900s — force-killing (pid $PID)"
        kill -9 "$PID" 2>/dev/null
        return 1
      fi
    done
    wait "$PID"
    local exit_code=$?
    elapsed=$(( $(date +%s) - start_ts ))
    if [ $exit_code -ne 0 ] && [ $elapsed -lt 45 ] && [ $attempt -lt 2 ]; then
      echo "[run] agent exited in ${elapsed}s with error — retrying once (attempt $attempt/2)"
      sleep 5
    else
      return $exit_code
    fi
  done
}

# Restart gateway: kill directly + start + poll health (avoids openclaw's 60s internal timeout)
restart_gateway() {
  echo "[run] restarting gateway..."
  # Kill any existing gateway processes on this port
  pkill -f "openclaw-gateway" 2>/dev/null || true
  sleep 2
  # Start gateway (uses LaunchAgent on macOS, or direct process on Linux)
  openclaw gateway start 2>/dev/null || true
  # Poll HTTP health — faster than openclaw's internal 60s wait
  local i=0
  while [ $i -lt 15 ]; do
    sleep 2; i=$(( i + 1 ))
    if curl -sf "http://127.0.0.1:${GATEWAY_PORT}/" -o /dev/null 2>&1; then
      echo "[run] gateway healthy (${i}x2s)"
      return 0
    fi
  done
  echo "[run] WARNING: gateway not healthy after 30s — proceeding"
}

# Start browser + poll Chrome CDP port until responsive (replaces fixed sleeps)
start_browser() {
  openclaw browser --browser-profile x-hunter stop 2>/dev/null || true
  sleep 1
  openclaw browser --browser-profile x-hunter start 2>/dev/null || true
  # Poll Chrome's CDP port directly — gateway-independent readiness check
  local i=0
  while [ $i -lt 15 ]; do
    sleep 2; i=$(( i + 1 ))
    if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" -o /dev/null 2>&1; then
      echo "[run] browser CDP ready (${i}x2s)"
      # Ensure at least one page tab exists — openclaw browser tool requires one to attach to.
      # When Chrome restarts fresh (after gateway crash/restart) it may have zero tabs,
      # causing the agent to get "tab not found" even though CDP is responding.
      local tab_count
      tab_count=$(curl -sf "http://127.0.0.1:${CDP_PORT}/json/list" 2>/dev/null \
        | grep -c '"type":"page"' 2>/dev/null)
      tab_count=${tab_count:-0}
      if [ "$tab_count" -eq 0 ]; then
        echo "[run] no page tabs found — opening x.com tab via CDP"
        curl -sf -X PUT "http://127.0.0.1:${CDP_PORT}/json/new?https://x.com" \
          -o /dev/null 2>/dev/null || true
        sleep 4  # give tab time to initialise before openclaw attaches
      fi
      return 0
    fi
  done
  echo "[run] WARNING: browser CDP not ready after 30s — proceeding"
}

# Functional browser health check via playwright-core (not just TCP port ping)
# Returns 0 if browser is healthy and accepting CDP connections, 1 otherwise
check_browser() {
  node "$PROJECT_ROOT/runner/browser_check.js" 2>/dev/null
  return $?
}

# Poll check_browser() every 2s until ready or timeout (seconds).
# Replaces blind sleep after gateway/browser restarts.
wait_for_browser_service() {
  local timeout="${1:-30}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if check_browser; then
      echo "[run] browser service ready (${elapsed}s)"
      return 0
    fi
    sleep 2; elapsed=$(( elapsed + 2 ))
  done
  echo "[run] WARNING: browser service not ready after ${timeout}s"
  return 1
}

# Ensure browser is healthy: check → restart if broken → retry up to 3 times
ensure_browser() {
  local attempt=0
  while [ $attempt -lt 3 ]; do
    if check_browser; then
      [ "$attempt" -gt 0 ] && echo "[run] browser recovered after $attempt restart(s)"
      return 0
    fi
    attempt=$(( attempt + 1 ))
    echo "[run] browser check failed (attempt $attempt/3) — restarting gateway + browser"
    restart_gateway
    start_browser
    wait_for_browser_service 30  # poll until openclaw control service reconnects (was sleep 15)
  done
  echo "[run] WARNING: browser unresponsive after 3 restart attempts — proceeding"
  return 1
}

# Detect if the gateway browser control service timed out during the last agent run.
# Compares gateway error log line counts before vs after the run to find new entries.
# Pass the line count captured before agent_run. Calls restart_gateway + start_browser
# if a "timed out after 20000ms" entry appeared during the run.
check_and_fix_gateway_timeout() {
  local before_lines=$1
  [ ! -f "$GATEWAY_ERR_LOG" ] && return 0
  local after_lines
  after_lines=$(wc -l < "$GATEWAY_ERR_LOG" 2>/dev/null || echo 0)
  local new_lines=$(( after_lines - before_lines ))
  [ "$new_lines" -le 0 ] && return 0
  if tail -n "$new_lines" "$GATEWAY_ERR_LOG" 2>/dev/null | grep -q "browser control service (timed out"; then
    echo "[run] browser control service timed out during agent run — restarting gateway"
    restart_gateway
    start_browser
    sleep 15
    check_browser && echo "[run] gateway browser service recovered" \
                  || echo "[run] WARNING: gateway still unhealthy after restart"
  fi
}

# Remove lock files whose owner PID is no longer running (prevents 10s lock timeouts)
clean_stale_locks() {
  local cleaned=0
  for lf in "$HOME/.openclaw/agents"/*/sessions/*.lock; do
    [ -f "$lf" ] || continue
    local lock_pid
    lock_pid=$(cat "$lf" 2>/dev/null | tr -d '[:space:]') || lock_pid="0"
    if [ -z "$lock_pid" ] || ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -f "$lf"
      cleaned=$(( cleaned + 1 ))
    fi
  done
  [ "$cleaned" -gt 0 ] && echo "[run] cleaned $cleaned stale lock(s)"
}

# Prevent macOS from sleeping while the runner is active.
# -s = prevent system sleep, -d = prevent display sleep.
# On Linux (GCP VM) caffeinate doesn't exist — skip silently.
if command -v caffeinate &>/dev/null; then
  caffeinate -sd -w $$ &
  CAFFEINATE_PID=$!
  echo "[run] caffeinate started (PID=$CAFFEINATE_PID) — Mac sleep disabled"
else
  echo "[run] caffeinate not available (Linux) — skipping"
fi

while true; do
  # ── Pause sentinel ────────────────────────────────────────────────────────
  if [ -f "$PROJECT_ROOT/runner/PAUSE" ]; then
    echo "[run] PAUSED (runner/PAUSE exists) — sleeping 60s. Remove file to resume."
    sleep 60
    continue
  fi

  CYCLE=$((CYCLE + 1))
  TODAY=$(date +%Y-%m-%d)
  NOW=$(date +%H:%M)
  HOUR=$(date +%H)
  CYCLE_START=$(date +%s)

  # Day number since agent start (Feb 23, 2026)
  _AGENT_START_EPOCH=$(date -j -f "%Y-%m-%d" "2026-02-23" "+%s" 2>/dev/null || date -d "2026-02-23" "+%s")
  _TODAY_EPOCH=$(date -j -f "%Y-%m-%d" "$TODAY" "+%s" 2>/dev/null || date -d "$TODAY" "+%s")
  DAY_NUMBER=$(( (_TODAY_EPOCH - _AGENT_START_EPOCH) / 86400 + 1 ))

  # Determine cycle type
  if [ $(( CYCLE % TWEET_EVERY )) -eq 0 ]; then
    CYCLE_TYPE="TWEET"
  elif [ $(( CYCLE % TWEET_EVERY )) -eq $QUOTE_OFFSET ]; then
    CYCLE_TYPE="QUOTE"
  else
    CYCLE_TYPE="BROWSE"
  fi

  # Suppress TWEET and QUOTE outside active hours -- downgrade to BROWSE
  if [ "$CYCLE_TYPE" = "TWEET" ] || [ "$CYCLE_TYPE" = "QUOTE" ]; then
    HOUR_INT=$(( 10#$HOUR ))
    if [ "$HOUR_INT" -lt "$TWEET_START" ] || [ "$HOUR_INT" -ge "$TWEET_END" ]; then
      echo "[run] Post window closed (hour=$HOUR), running as BROWSE instead of $CYCLE_TYPE"
      CYCLE_TYPE="BROWSE"
    fi
  fi

  # Detect first-ever run by absence of journal files
  JOURNAL_COUNT=$(ls "$PROJECT_ROOT/journals/"*.html 2>/dev/null | wc -l | tr -d ' ')

  # Check if scraper has produced any digest yet
  DIGEST_SIZE=$(wc -c < "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null || echo 0)

  echo "[run] ── Cycle $CYCLE ($CYCLE_TYPE) — $TODAY $NOW (journals=$JOURNAL_COUNT, digest=${DIGEST_SIZE}b) ──"

  # ── Heartbeat: external liveness signal ───────────────────────────────────
  printf "cycle: %s | type: %s | %s %s\n" "$CYCLE" "$CYCLE_TYPE" "$TODAY" "$NOW" > "$PROJECT_ROOT/HEARTBEAT.md"

  # ── Clean stale lock files from any interrupted previous cycle ────────────
  clean_stale_locks

  # ── Scraper liveness: restart collect/reply loops if they died or pid missing ─
  _scraper_needs_restart=0
  for _loop in scraper reply follows; do
    _pid_file="$PROJECT_ROOT/scraper/${_loop}.pid"
    if [ ! -f "$_pid_file" ]; then
      echo "[run] ${_loop} pid file missing — restarting scraper..."
      _scraper_needs_restart=1
      break
    fi
    _pid=$(cat "$_pid_file" 2>/dev/null || echo "0")
    if ! kill -0 "$_pid" 2>/dev/null; then
      echo "[run] ${_loop} loop dead (pid ${_pid}) — restarting scraper..."
      _scraper_needs_restart=1
      break
    fi
  done
  if [ "$_scraper_needs_restart" -eq 1 ]; then
    bash "$PROJECT_ROOT/scraper/start.sh" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
  fi

  # ── Ensure browser is alive before each cycle (fast path for BROWSE) ─────
  # TWEET/QUOTE cycles run ensure_browser() below for full retry logic.
  # For BROWSE cycles, check CDP *and* gateway port before starting the agent.
  # check_browser() only verifies CDP (18801); gateway (18789) can be down separately
  # (e.g., mid-cycle crash of a previous cycle) causing "tab not found" errors.
  if [ "$CYCLE_TYPE" = "BROWSE" ]; then
    if ! check_browser; then
      echo "[run] browser CDP down before browse cycle — restarting gateway + browser"
      restart_gateway
      start_browser
      sleep 15
    elif ! curl -sf "http://127.0.0.1:${GATEWAY_PORT}/" -o /dev/null 2>&1; then
      echo "[run] gateway port ${GATEWAY_PORT} not responding — restarting gateway"
      restart_gateway
      sleep 10
    fi
  fi

  # ── Before tweet/quote cycles: ensure clean session + healthy browser ────────
  #    Only hard-restart gateway+browser if CDP is not responding.
  #    If browser is already healthy, session reset is sufficient — a hard restart
  #    triggers a LaunchAgent cycle that leaves the browser control service
  #    temporarily unavailable (causes "browser control service timed out").
  if [ "$CYCLE_TYPE" = "TWEET" ] || [ "$CYCLE_TYPE" = "QUOTE" ]; then
    reset_session x-hunter-tweet  # always flush tweet agent session
  fi
  # ensure_browser needed for TWEET and QUOTE — both post via CDP (post_tweet.js / post_quote.js)
  if [ "$CYCLE_TYPE" = "TWEET" ] || [ "$CYCLE_TYPE" = "QUOTE" ]; then
    ensure_browser
  fi

  # ── Reset browse session periodically (every 6 cycles = 2h) ──────────────
  # Must restart gateway (not just wipe files) -- gateway caches session in memory.
  if [ $(( CYCLE % 6 )) -eq 0 ]; then
    reset_session x-hunter
    restart_gateway
    start_browser
    if wait_for_browser_service 30; then
      echo "[run] browser healthy after reset"
    else
      echo "[run] WARNING: browser not ready after reset — downgrading TWEET/QUOTE to BROWSE"
      CYCLE_TYPE="BROWSE"
    fi
    echo "[run] x-hunter session + gateway restarted (context flush cycle $CYCLE)"
  fi

  # ── Second lock sweep: gateway/browser restarts may have orphaned new locks ─
  clean_stale_locks

  # ── First-ever cycle: intro tweet + profile setup ─────────────────────────
  if [ "$JOURNAL_COUNT" -eq 0 ]; then
    AGENT_MSG=$(DAY_NUMBER=$DAY_NUMBER TODAY=$TODAY NOW="$NOW" HOUR=$HOUR node "$SCRIPT_DIR/lib/prompts/first_run.js")
    _gw_before=$(wc -l < "$GATEWAY_ERR_LOG" 2>/dev/null || echo 0)
    agent_run --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking high \
      --verbose on
    check_and_fix_gateway_timeout "$_gw_before"

  # ── Browse cycle: read digest + topic summary, take notes ───────────────
  elif [ "$CYCLE_TYPE" = "BROWSE" ]; then
    # ── FTS5 self-heal: rebuild index if corrupted ────────────────────────
    _FTS_CHECK=$(sqlite3 "$PROJECT_ROOT/state/index.db" "INSERT INTO memory_fts(memory_fts) VALUES('integrity-check');" 2>&1)
    if [ -n "$_FTS_CHECK" ]; then
      echo "[run] FTS5 corruption detected — rebuilding indexes"
      sqlite3 "$PROJECT_ROOT/state/index.db" "INSERT INTO memory_fts(memory_fts) VALUES('rebuild');" 2>/dev/null || true
      sqlite3 "$PROJECT_ROOT/state/index.db" "INSERT INTO posts_fts(posts_fts) VALUES('rebuild');" 2>/dev/null || true
      echo "[run] FTS5 rebuild done"
    fi

    # Generate topic summary + memory recall from SQLite index before invoking AI
    node "$PROJECT_ROOT/scraper/query.js" --hours 4 > /dev/null 2>&1 || true
    # Extract top 3 keywords from topic_summary.txt to make recall topic-relevant
    RECALL_QUERY=$(grep -E '^[0-9]+x[[:space:]]' "$PROJECT_ROOT/state/topic_summary.txt" 2>/dev/null | sed 's/^[0-9][0-9]*x[[:space:]]*//' | head -3 | tr '\n' ' ' | xargs)
    if [ -n "$RECALL_QUERY" ]; then
      node "$PROJECT_ROOT/runner/recall.js" --query "$RECALL_QUERY" --limit 5 >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    else
      node "$PROJECT_ROOT/runner/recall.js" --limit 5 >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    # Curiosity directive: refresh every 12th browse cycle (~4h)
    # Pass CURIOSITY_CYCLE + CURIOSITY_EVERY so curiosity.js can compute expiry
    if [ $(( CYCLE % CURIOSITY_EVERY )) -eq 0 ]; then
      CURIOSITY_CYCLE=$CYCLE CURIOSITY_EVERY=$CURIOSITY_EVERY \
        node "$PROJECT_ROOT/runner/curiosity.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

      # Axis clustering: detect semantically redundant belief axes, propose merges
      node "$PROJECT_ROOT/runner/cluster_axes.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    # Comment candidates: posts where memory has something specific to say
    node "$PROJECT_ROOT/runner/comment_candidates.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Discourse scan: assess recent reply exchanges for substantive counter-reasoning
    # Writes discourse_anchors.jsonl; curiosity.js treats these as highest-priority triggers
    node "$PROJECT_ROOT/runner/discourse_scan.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Discourse digest: format recent exchanges for agent context (browse + tweet prompts)
    node "$PROJECT_ROOT/runner/discourse_digest.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Reading queue: scan interactions for user-recommended URLs, emit top item
    READING_CYCLE=$CYCLE node "$PROJECT_ROOT/runner/reading_queue.js" \
      >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Auto deep-dive detector: every 6 cycles, find recurring accounts worth profiling
    if [ $(( CYCLE % 6 )) -eq 0 ]; then
      READING_CYCLE=$CYCLE node "$PROJECT_ROOT/runner/deep_dive_detector.js" \
        >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    # Pre-fetch curiosity search URL in browser (non-blocking — page ready when agent starts)
    PREFETCH_CYCLE=$CYCLE node "$PROJECT_ROOT/runner/prefetch_url.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    _BROWSE_JOURNAL_PATH="$PROJECT_ROOT/journals/${TODAY}_${HOUR}.html"
    AGENT_MSG=$(CYCLE=$CYCLE DAY_NUMBER=$DAY_NUMBER TODAY=$TODAY NOW="$NOW" HOUR=$HOUR node "$SCRIPT_DIR/lib/prompts/browse.js")
    _gw_before=$(wc -l < "$GATEWAY_ERR_LOG" 2>/dev/null || echo 0)
    _JOURNAL_BEFORE=$(git -C "$PROJECT_ROOT" status --porcelain -- "journals/${TODAY}_${HOUR}.html" 2>/dev/null | wc -l | tr -d ' ')
    agent_run --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on
    check_and_fix_gateway_timeout "$_gw_before"
    # If agent crashed without writing a journal, retry once
    _JOURNAL_AFTER=$(git -C "$PROJECT_ROOT" status --porcelain -- "journals/${TODAY}_${HOUR}.html" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$_JOURNAL_AFTER" = "$_JOURNAL_BEFORE" ] && [ "$_JOURNAL_BEFORE" = "0" ] && [ ! -f "$_BROWSE_JOURNAL_PATH" ]; then
      echo "[run] browse journal missing after agent run — retrying once (no thinking)"
      sleep 5
      _gw_before=$(wc -l < "$GATEWAY_ERR_LOG" 2>/dev/null || echo 0)
      agent_run --agent x-hunter \
        --message "$AGENT_MSG" \
        --verbose on
      check_and_fix_gateway_timeout "$_gw_before"
    fi

    # ── Close excess Chrome tabs after browse agent (prevents memory accumulation) ─
    node "$PROJECT_ROOT/runner/cleanup_tabs.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Mark reading queue item as done (agent has read it) ───────────────
    if [ -s "$PROJECT_ROOT/state/reading_url.txt" ]; then
      READING_CYCLE=$CYCLE node "$PROJECT_ROOT/runner/reading_queue.js" --mark-done \
        >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    # ── Merge ontology delta written by the browse agent ──────────────────
    node "$PROJECT_ROOT/runner/apply_ontology_delta.js" 2>&1 || true

    # ── Detect drift / change points in belief axes ────────────────────────
    node "$PROJECT_ROOT/runner/detect_drift.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Commit + push browse journal if agent wrote one this cycle ─────────
    _JOURNAL_FILE="$PROJECT_ROOT/journals/${TODAY}_${HOUR}.html"
    if git -C "$PROJECT_ROOT" status --porcelain -- "${TODAY}_${HOUR}.html" journals/ 2>/dev/null | grep -q "journals/${TODAY}_${HOUR}.html"; then
      # Suppress failure journals — do not publish browser-unavailable cycles
      _IS_FAILURE=false
      if [ -f "$_JOURNAL_FILE" ]; then
        if grep -qi "browser control service\|browser.*unavailable\|unable to perform its core function\|no new observations" "$_JOURNAL_FILE" 2>/dev/null; then
          _IS_FAILURE=true
        fi
      fi
      if [ "$_IS_FAILURE" = "true" ]; then
        echo "[run] Browse journal is a failure cycle — suppressing commit/push/archive"
        git -C "$PROJECT_ROOT" checkout -- "journals/${TODAY}_${HOUR}.html" 2>/dev/null || \
          rm -f "$_JOURNAL_FILE"
      else
        echo "[run] Browse journal written — committing and pushing..."
        git -C "$PROJECT_ROOT" add journals/ state/ 2>/dev/null || true
        git -C "$PROJECT_ROOT" commit -m "journal: ${TODAY} ${HOUR} (browse cycle ${CYCLE})" 2>/dev/null || true
        git -C "$PROJECT_ROOT" push origin main 2>/dev/null || true
        echo "[run] browse journal pushed"
        node "$PROJECT_ROOT/runner/archive.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
        CYCLE_TYPE=JOURNAL node "$PROJECT_ROOT/runner/watchdog.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
      fi
    fi

    # ── Moltbook heartbeat: check notifications, upvote feed content ─────────
    node "$PROJECT_ROOT/runner/moltbook.js" --heartbeat >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Retry pending checkpoint post if rate limit has cleared ──────────
    if [ -f "$PROJECT_ROOT/state/checkpoint_pending" ]; then
      node "$PROJECT_ROOT/runner/moltbook.js" --post-checkpoint >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    # ── Retry pending checkpoint tweet if previous attempt failed ─────────
    if [ -f "$PROJECT_ROOT/state/checkpoint_result.txt" ]; then
      _CP_URL=$(sed -n '1p' "$PROJECT_ROOT/state/checkpoint_result.txt" | tr -d '\n')
      _CP_TITLE=$(sed -n '2p' "$PROJECT_ROOT/state/checkpoint_result.txt" | tr -d '\n')
      _MAX_CP=$(( 240 - ${#_CP_URL} ))
      if [ ${#_CP_TITLE} -gt $_MAX_CP ]; then _CP_TITLE="${_CP_TITLE:0:$_MAX_CP}..."; fi
      printf "%s\n%s" "$_CP_TITLE" "$_CP_URL" > "$PROJECT_ROOT/state/tweet_draft.txt"
      echo "[run] retrying checkpoint tweet: $_CP_URL"
      _CP_OUT=$(node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1)
      _CP_RC=$?
      echo "$_CP_OUT" | grep -v '^$'
      if [ "$_CP_RC" -eq 0 ]; then rm -f "$PROJECT_ROOT/state/checkpoint_result.txt"; fi
    fi

    # ── Process pending replies after each browse cycle ───────────────────
    node "$PROJECT_ROOT/scraper/reply.js" 2>&1 || true

  # ── Quote cycle: find one post worth quoting + sharp commentary ──────────
  elif [ "$CYCLE_TYPE" = "QUOTE" ]; then
    AGENT_MSG=$(CYCLE=$CYCLE DAY_NUMBER=$DAY_NUMBER TODAY=$TODAY NOW="$NOW" HOUR=$HOUR node "$SCRIPT_DIR/lib/prompts/quote.js")
    # Snapshot critical JSON state before quote agent runs
    for _sf in posts_log ontology belief_state; do
      _fp="$PROJECT_ROOT/state/${_sf}.json"
      [ -f "$_fp" ] && cp "$_fp" "${_fp}.bak" 2>/dev/null || true
    done
    chmod 444 "$PROJECT_ROOT/state/posts_log.json" 2>/dev/null || true

    rm -f "$PROJECT_ROOT/state/quote_draft.txt" "$PROJECT_ROOT/state/quote_result.txt"
    agent_run --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

    # Restore write permission + validate state files after quote agent
    chmod 644 "$PROJECT_ROOT/state/posts_log.json" 2>/dev/null || true
    for _sf in posts_log ontology belief_state; do
      _fp="$PROJECT_ROOT/state/${_sf}.json"
      if [ -f "$_fp" ] && [ -f "${_fp}.bak" ]; then
        if ! node -e "JSON.parse(require('fs').readFileSync('$_fp','utf-8'))" 2>/dev/null; then
          echo "[run] WARNING: ${_sf}.json is malformed after quote — restoring from .bak"
          cp "${_fp}.bak" "$_fp" || true
        elif [ "$_sf" = "posts_log" ]; then
          _cur_count=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$_fp','utf-8')).posts.length)}catch(e){console.log(0)}" 2>/dev/null)
          _bak_count=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${_fp}.bak','utf-8')).posts.length)}catch(e){console.log(0)}" 2>/dev/null)
          if [ "$_cur_count" -lt "$_bak_count" ]; then
            echo "[run] WARNING: posts_log.json lost entries after quote (${_bak_count} → ${_cur_count}) — restoring from .bak"
            cp "${_fp}.bak" "$_fp"
          fi
        fi
      fi
    done

    # ── Close excess Chrome tabs after quote agent ────────────────────────
    node "$PROJECT_ROOT/runner/cleanup_tabs.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Voice filter: Ollama revises quote tone/personality based on belief stance ──
    if [ -f "$PROJECT_ROOT/state/quote_draft.txt" ]; then
      _QVF_OUT=$(node "$PROJECT_ROOT/runner/voice_filter.js" --quote 2>&1)
      echo "[run] voice filter (quote): $_QVF_OUT"
    fi

    # ── Post quote-tweet via CDP (runner handles, no browser tool needed) ──────
    if [ -f "$PROJECT_ROOT/state/quote_draft.txt" ]; then
      echo "[run] Posting quote-tweet via CDP..."
      sleep 3  # give openclaw gateway time to release browser WS before CDP connect
      node "$PROJECT_ROOT/runner/post_quote.js" 2>&1
      QUOTE_URL=$(cat "$PROJECT_ROOT/state/quote_result.txt" 2>/dev/null | tr -d '\n')
      # posts_log.json is written by post_quote.js directly
      if [ -n "$QUOTE_URL" ] && [ "$QUOTE_URL" != "posted" ]; then
        echo "[run] Quote posted: $QUOTE_URL"
      fi
    else
      echo "[run] No quote_draft.txt — agent did not produce a quote"
    fi

    # Watchdog: verify quote was posted, retry once if result is missing
    CYCLE_TYPE=QUOTE node "$PROJECT_ROOT/runner/watchdog.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Coherence critique of the quote tweet
    node "$PROJECT_ROOT/runner/critique.js" --quote --cycle "$CYCLE" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # (Moltbook: quote cross-posting removed — Moltbook receives articles only)

  # ── Tweet cycle: synthesize, journal, tweet, push ─────────────────────────
  else
    # Archive browse_notes.md before the agent clears it (task 7)
    # Keeps a rolling 48h window in state/browse_archive.md
    if [ -s "$PROJECT_ROOT/state/browse_notes.md" ]; then
      {
        echo ""
        echo "── $TODAY $NOW · cycle $CYCLE ──────────────────────────────────────────"
        cat "$PROJECT_ROOT/state/browse_notes.md"
      } >> "$PROJECT_ROOT/state/browse_archive.md"
      # Keep browse_archive.md under 6000 lines (~48h of 2h windows)
      ARCH_LINES=$(wc -l < "$PROJECT_ROOT/state/browse_archive.md" 2>/dev/null || echo 0)
      if [ "$ARCH_LINES" -gt 6000 ]; then
        tail -n 5000 "$PROJECT_ROOT/state/browse_archive.md" > /tmp/hunter_arch_trim \
          && mv /tmp/hunter_arch_trim "$PROJECT_ROOT/state/browse_archive.md"
        echo "[run] trimmed browse_archive.md to 5000 lines"
      fi
    fi

    # Snapshot critical JSON state before agent runs — restore if agent corrupts them
    for _sf in posts_log ontology belief_state; do
      _fp="$PROJECT_ROOT/state/${_sf}.json"
      [ -f "$_fp" ] && cp "$_fp" "${_fp}.bak" 2>/dev/null || true
    done

    # Make posts_log.json read-only so the agent cannot overwrite it
    chmod 444 "$PROJECT_ROOT/state/posts_log.json" 2>/dev/null || true

    # Shell guard: if browse notes are empty or a browser-failure cycle, skip tweet immediately
    _BROWSE_NOTES_RAW=$(cat "$PROJECT_ROOT/state/browse_notes.md" 2>/dev/null || echo "")
    _BROWSE_NOTES_LEN=${#_BROWSE_NOTES_RAW}
    _BROWSE_FAILED=false
    if [ "$_BROWSE_NOTES_LEN" -lt 80 ]; then
      _BROWSE_FAILED=true
    elif echo "$_BROWSE_NOTES_RAW" | grep -qi "browser control service\|browser.*unavailable\|no new observations\|unable to perform"; then
      _BROWSE_FAILED=true
    fi
    if [ "$_BROWSE_FAILED" = "true" ]; then
      echo "[run] Browse notes empty or browser-failure cycle — skipping tweet (writing SKIP)"
      printf "SKIP\n" > "$PROJECT_ROOT/state/tweet_draft.txt"
    else

    AGENT_MSG=$(CYCLE=$CYCLE DAY_NUMBER=$DAY_NUMBER TODAY=$TODAY NOW="$NOW" HOUR=$HOUR node "$SCRIPT_DIR/lib/prompts/tweet.js")
    rm -f "$PROJECT_ROOT/state/tweet_draft.txt" "$PROJECT_ROOT/state/tweet_result.txt"
    agent_run --agent x-hunter-tweet \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on
    # If agent crashed without writing tweet_draft.txt, retry once
    if [ ! -f "$PROJECT_ROOT/state/tweet_draft.txt" ]; then
      echo "[run] tweet_draft.txt missing after agent run — retrying once (no thinking)"
      sleep 5
      agent_run --agent x-hunter-tweet \
        --message "$AGENT_MSG" \
        --verbose on
    fi
    fi  # end: browse notes guard

    # ── Close excess Chrome tabs after tweet agent ────────────────────────
    node "$PROJECT_ROOT/runner/cleanup_tabs.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Restore write permission on posts_log.json BEFORE post scripts run
    # (was read-only during agent run to prevent agent from overwriting it)
    chmod 644 "$PROJECT_ROOT/state/posts_log.json" 2>/dev/null || true

    # ── Validate + restore state files if agent wrote malformed JSON ────────
    for _sf in posts_log ontology belief_state; do
      _fp="$PROJECT_ROOT/state/${_sf}.json"
      if [ -f "$_fp" ] && [ -f "${_fp}.bak" ]; then
        if ! node -e "JSON.parse(require('fs').readFileSync('$_fp','utf-8'))" 2>/dev/null; then
          echo "[run] WARNING: ${_sf}.json is malformed — restoring from .bak"
          cp "${_fp}.bak" "$_fp" || true
        elif [ "$_sf" = "posts_log" ]; then
          _cur_count=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$_fp','utf-8')).posts.length)}catch(e){console.log(0)}" 2>/dev/null)
          _bak_count=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${_fp}.bak','utf-8')).posts.length)}catch(e){console.log(0)}" 2>/dev/null)
          if [ "$_cur_count" -lt "$_bak_count" ]; then
            echo "[run] WARNING: posts_log.json lost entries (${_bak_count} → ${_cur_count}) — restoring from .bak"
            cp "${_fp}.bak" "$_fp"
          fi
        fi
      fi
    done

    # ── Merge ontology delta written by the tweet agent ───────────────────
    node "$PROJECT_ROOT/runner/apply_ontology_delta.js" 2>&1 || true

    # ── Detect drift / change points in belief axes ────────────────────────
    node "$PROJECT_ROOT/runner/detect_drift.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Auto-append journal URL if agent forgot it ──────────────────────────
    if [ -f "$PROJECT_ROOT/state/tweet_draft.txt" ]; then
      _DRAFT_CONTENT=$(cat "$PROJECT_ROOT/state/tweet_draft.txt")
      _DRAFT_LINE1_FIX=$(echo "$_DRAFT_CONTENT" | head -n1)
      _DRAFT_LINE2_FIX=$(echo "$_DRAFT_CONTENT" | sed -n '2p')
      _EXPECTED_URL="https://sebastianhunter.fun/journal/${TODAY}/${HOUR}"
      if [ "$_DRAFT_LINE1_FIX" != "SKIP" ] && [ -n "$_DRAFT_LINE1_FIX" ]; then
        if [ -z "$_DRAFT_LINE2_FIX" ] || ! echo "$_DRAFT_LINE2_FIX" | grep -q "^https://"; then
          echo "[run] tweet_draft.txt missing journal URL on line 2 — auto-appending"
          printf "%s\n%s\n" "$_DRAFT_LINE1_FIX" "$_EXPECTED_URL" > "$PROJECT_ROOT/state/tweet_draft.txt"
        fi
      fi
    fi

    # ── Critique gate: Ollama specificity + falsifiability check ─────────────
    if [ -f "$PROJECT_ROOT/state/tweet_draft.txt" ]; then
      _DRAFT_LINE1=$(head -n1 "$PROJECT_ROOT/state/tweet_draft.txt")
      if [ "$_DRAFT_LINE1" != "SKIP" ] && [ -n "$_DRAFT_LINE1" ]; then
        _CRITIQUE=$(node "$PROJECT_ROOT/runner/critique_tweet.js" 2>/dev/null)
        echo "[run] tweet critique: $_CRITIQUE"
        if echo "$_CRITIQUE" | grep -q "^REJECT"; then
          echo "[run] Tweet rejected by critique gate — skipping post this cycle"
          rm -f "$PROJECT_ROOT/state/tweet_draft.txt"
        fi
      fi
    fi

    # ── Voice filter: Ollama revises tone/personality based on belief stance ──
    if [ -f "$PROJECT_ROOT/state/tweet_draft.txt" ]; then
      _DRAFT_LINE1_VF=$(head -n1 "$PROJECT_ROOT/state/tweet_draft.txt")
      if [ "$_DRAFT_LINE1_VF" != "SKIP" ] && [ -n "$_DRAFT_LINE1_VF" ]; then
        _VF_OUT=$(node "$PROJECT_ROOT/runner/voice_filter.js" 2>&1)
        echo "[run] voice filter: $_VF_OUT"
      fi
    fi

    # ── Post tweet via CDP (no browser tool needed from agent) ──────────────
    if [ -f "$PROJECT_ROOT/state/tweet_draft.txt" ]; then
      DRAFT=$(cat "$PROJECT_ROOT/state/tweet_draft.txt")
      if [ "$DRAFT" = "SKIP" ]; then
        echo "[run] Agent chose to skip tweet this cycle (self-check failed)"
      else
        echo "[run] Posting tweet via CDP..."
        node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1
        TWEET_URL=$(cat "$PROJECT_ROOT/state/tweet_result.txt" 2>/dev/null | tr -d '\n')
        # posts_log.json is written by post_tweet.js directly
        if [ -n "$TWEET_URL" ] && [ "$TWEET_URL" != "posted" ]; then
          echo "[run] Tweet posted: $TWEET_URL"
        else
          echo "[run] Tweet posted (URL not captured or post_tweet.js failed)"
        fi
      fi
    else
      echo "[run] No tweet_draft.txt — agent did not produce a draft"
    fi

    # Watchdog: verify tweet was posted, retry once if result is missing
    CYCLE_TYPE=TWEET node "$PROJECT_ROOT/runner/watchdog.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Git commit and push ─────────────────────────────────────────────────
    git -C "$PROJECT_ROOT" add journals/ checkpoints/ state/ articles/ daily/ ponders/ 2>/dev/null || true
    git -C "$PROJECT_ROOT" commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}" 2>/dev/null || true
    git -C "$PROJECT_ROOT" push origin main 2>/dev/null || true
    echo "[run] git push done"
    # Trigger Vercel redeploy if a deploy hook URL is configured
    if [ -n "${VERCEL_DEPLOY_HOOK:-}" ]; then
      curl -s -X POST "$VERCEL_DEPLOY_HOOK" > /dev/null 2>&1 || true
      echo "[run] Vercel deploy hook triggered"
    fi

    # Archive new journals/checkpoints to Irys + local memory index
    node "$PROJECT_ROOT/runner/archive.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Watchdog: verify latest journal committed, pushed, and on Arweave
    CYCLE_TYPE=JOURNAL node "$PROJECT_ROOT/runner/watchdog.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Runner clears browse_notes.md (agent write tool rejects empty string) ──
    printf "" > "$PROJECT_ROOT/state/browse_notes.md"
    echo "[run] browse_notes.md cleared"

    # Coherence critique of the journal + tweet (only if agent actually posted this cycle)
    node "$PROJECT_ROOT/runner/critique.js" --cycle "$CYCLE" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
  fi

  # ── Daily maintenance block ──────────────────────────────────────────────
  # Runs every cycle but self-gates to once per 24h. Moved OUTSIDE the
  # BROWSE/QUOTE/TWEET if-elif-else so it fires regardless of cycle type.
  # All tasks are standalone node scripts — no browser/agent needed.
  _LAST_DAILY_FILE="$PROJECT_ROOT/state/last_daily_at.txt"
  _NOW_EPOCH=$(date +%s)
  _LAST_DAILY_EPOCH=0
  if [ -f "$_LAST_DAILY_FILE" ]; then
    _LAST_DAILY_EPOCH=$(cat "$_LAST_DAILY_FILE" 2>/dev/null || echo 0)
  fi
  _DAILY_ELAPSED=$(( _NOW_EPOCH - _LAST_DAILY_EPOCH ))
  if [ "$_DAILY_ELAPSED" -ge 86400 ]; then
    echo "[run] ── Daily block firing (${_DAILY_ELAPSED}s since last) ──"
    # ── Daily belief report ──────────────────────────────────────────────────
    node "$PROJECT_ROOT/runner/generate_daily_report.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Daily article: write from journals + beliefs, post to Moltbook ───────
    node "$PROJECT_ROOT/runner/write_article.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    node "$PROJECT_ROOT/runner/moltbook.js" --post-article >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Tweet the Moltbook article link ──────────────────────────────────────
    # Daily block tweets need a browser — ensure it's healthy before first attempt.
    # Article result may already exist; sprint/plan/ponder tweets are created later
    # in this block but ensure_browser is cheap to re-call (returns instantly if healthy).
    # Give browser 15s to settle after browse cycle agent release
    sleep 15
    ensure_browser
    if [ -f "$PROJECT_ROOT/state/article_result.txt" ]; then
      _ARTICLE_URL=$(sed -n '1p' "$PROJECT_ROOT/state/article_result.txt" | tr -d '\n')
      _ARTICLE_TITLE=$(sed -n '2p' "$PROJECT_ROOT/state/article_result.txt" | tr -d '\n')
      # Truncate title to fit within 280 chars (title + newline + URL)
      _MAX_TITLE=$(( 255 - ${#_ARTICLE_URL} ))
      if [ ${#_ARTICLE_TITLE} -gt $_MAX_TITLE ]; then
        _ARTICLE_TITLE="${_ARTICLE_TITLE:0:$_MAX_TITLE}..."
      fi
      printf "%s\n%s" "$_ARTICLE_TITLE" "$_ARTICLE_URL" > "$PROJECT_ROOT/state/tweet_draft.txt"
      echo "[run] tweeting article link: $_ARTICLE_URL"
      _ART_TWEET_OK=false
      for _ART_ATTEMPT in 1 2; do
        _TWEET_OUT=$(node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1)
        _TWEET_RC=$?
        echo "$_TWEET_OUT" | grep -v '^$'
        if [ "$_TWEET_RC" -eq 0 ]; then
          rm -f "$PROJECT_ROOT/state/article_result.txt"
          _ART_TWEET_OK=true
          break
        fi
        echo "[run] article tweet attempt $_ART_ATTEMPT failed (rc=$_TWEET_RC)"
        if [ "$_ART_ATTEMPT" -lt 2 ]; then
          echo "[run] waiting 20s before retry..."
          sleep 20
          ensure_browser
        fi
      done
      if [ "$_ART_TWEET_OK" = "false" ]; then
        echo "[run] article tweet failed after 2 attempts — keeping article_result.txt for retry"
      fi
      sleep 60  # rate-limit gap before next tweet (avoid X spam detection)
    fi
    # ── Checkpoint (every 3 days — generate_checkpoint.js self-gates) ───────
    node "$PROJECT_ROOT/runner/generate_checkpoint.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Vocation evaluation (runs after checkpoint, self-gates on checkpoint count) ──
    node "$PROJECT_ROOT/runner/evaluate_vocation.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Bio update (runs after vocation eval, self-gates on status change) ───
    node "$PROJECT_ROOT/runner/update_bio.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    node "$PROJECT_ROOT/runner/moltbook.js" --post-checkpoint >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Tweet the checkpoint link ────────────────────────────────────────────
    if [ -f "$PROJECT_ROOT/state/checkpoint_result.txt" ]; then
      _CP_URL=$(sed -n '1p' "$PROJECT_ROOT/state/checkpoint_result.txt" | tr -d '\n')
      _CP_TITLE=$(sed -n '2p' "$PROJECT_ROOT/state/checkpoint_result.txt" | tr -d '\n')
      _MAX_CP=$(( 240 - ${#_CP_URL} ))
      if [ ${#_CP_TITLE} -gt $_MAX_CP ]; then
        _CP_TITLE="${_CP_TITLE:0:$_MAX_CP}..."
      fi
      printf "%s\n%s" "$_CP_TITLE" "$_CP_URL" > "$PROJECT_ROOT/state/tweet_draft.txt"
      echo "[run] tweeting checkpoint link: $_CP_URL"
      _CP_TWEET_OUT=$(node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1)
      _CP_TWEET_RC=$?
      echo "$_CP_TWEET_OUT" | grep -v '^$'
      if [ "$_CP_TWEET_RC" -eq 0 ]; then
        rm -f "$PROJECT_ROOT/state/checkpoint_result.txt"
      else
        echo "[run] checkpoint tweet failed (rc=$_CP_TWEET_RC) — keeping checkpoint_result.txt for retry"
      fi
      sleep 60  # rate-limit gap
    fi
    # ── Ponder (fires after checkpoint if conviction threshold met) ───────────
    node "$PROJECT_ROOT/runner/ponder.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # Post plan announcement tweet if decision.js activated a plan
    if [ -f "$PROJECT_ROOT/state/plan_tweet.txt" ]; then
      cp "$PROJECT_ROOT/state/plan_tweet.txt" "$PROJECT_ROOT/state/tweet_draft.txt"
      node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1 | grep -v '^$' || true
      rm -f "$PROJECT_ROOT/state/plan_tweet.txt"
      echo "[run] plan announcement tweet posted"
      sleep 60  # rate-limit gap
    fi
    # Post ponder declaration tweet if ponder fired and wrote a draft
    if [ -f "$PROJECT_ROOT/state/ponder_tweet.txt" ]; then
      cp "$PROJECT_ROOT/state/ponder_tweet.txt" "$PROJECT_ROOT/state/tweet_draft.txt"
      node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1 | grep -v '^$' || true
      rm -f "$PROJECT_ROOT/state/ponder_tweet.txt"
      echo "[run] ponder declaration tweet posted"
      # Flag Moltbook ponder post as pending — will retry each daily cycle until success
      touch "$PROJECT_ROOT/state/ponder_post_pending"
      sleep 10  # rate-limit gap
    fi
    # Moltbook ponder post — retries every daily cycle until it succeeds and clears the flag
    if [ -f "$PROJECT_ROOT/state/ponder_post_pending" ]; then
      node "$PROJECT_ROOT/runner/moltbook.js" --post-ponder >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi
    # ── Ponder pipeline: deep_dive (fires 1d after ponder, self-gating) ──────
    node "$PROJECT_ROOT/runner/deep_dive.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Ponder pipeline: decision (fires after deep_dive completes, self-gating) ─
    node "$PROJECT_ROOT/runner/decision.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Sprint manager (daily: sync plan → track progress → plan next sprint) ──
    node "$PROJECT_ROOT/runner/sprint_manager.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # ── Sprint update: generate tweet + Moltbook post if milestone reached ──
    node "$PROJECT_ROOT/runner/sprint_update.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # Post sprint progress tweet if sprint_update.js wrote a draft
    if [ -f "$PROJECT_ROOT/state/sprint_tweet.txt" ]; then
      cp "$PROJECT_ROOT/state/sprint_tweet.txt" "$PROJECT_ROOT/state/tweet_draft.txt"
      node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1 | grep -v '^$' || true
      rm -f "$PROJECT_ROOT/state/sprint_tweet.txt"
      echo "[run] sprint progress tweet posted"
    fi
    # Post sprint update to Moltbook if draft exists
    node "$PROJECT_ROOT/runner/moltbook.js" --sprint-update >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # Trim feed_digest.txt to last 3000 lines (~2-3 days of data)
    DLINES=$(wc -l < "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null || echo 0)
    if [ "$DLINES" -gt 3000 ]; then
      tail -n 3000 "$PROJECT_ROOT/state/feed_digest.txt" > /tmp/hunter_digest_trim \
        && mv /tmp/hunter_digest_trim "$PROJECT_ROOT/state/feed_digest.txt"
      echo "[run] trimmed feed_digest.txt: ${DLINES} → 3000 lines"
    fi
    # Rotate logs: keep last 5000 lines of runner.log, 3000 of scraper.log
    # IMPORTANT: use cp+truncate pattern to preserve inodes — the running shell
    # holds fd 1 open on runner.log; mv would orphan it onto a deleted inode.
    for _log_pair in "$PROJECT_ROOT/runner/runner.log:5000" "$PROJECT_ROOT/scraper/scraper.log:3000"; do
      _lf="${_log_pair%%:*}"; _lk="${_log_pair##*:}"
      if [ -f "$_lf" ]; then
        _lc=$(wc -l < "$_lf" 2>/dev/null || echo 0)
        if [ "$_lc" -gt "$_lk" ]; then
          tail -n "$_lk" "$_lf" > "${_lf}.tmp"
          cat "${_lf}.tmp" > "$_lf"   # overwrite in-place (preserves inode)
          rm -f "${_lf}.tmp"
          echo "[run] rotated $(basename "$_lf") to last ${_lk} lines"
        fi
      fi
    done
    # ── Git commit daily outputs ───────────────────────────────────────────
    git -C "$PROJECT_ROOT" add journals/ checkpoints/ state/ articles/ daily/ ponders/ 2>/dev/null || true
    git -C "$PROJECT_ROOT" commit -m "daily: ${TODAY}" 2>/dev/null || true
    git -C "$PROJECT_ROOT" push origin main 2>/dev/null || true
    # Trigger Vercel redeploy for new article/checkpoint
    if [ -n "${VERCEL_DEPLOY_HOOK:-}" ]; then
      curl -s -X POST "$VERCEL_DEPLOY_HOOK" > /dev/null 2>&1 || true
    fi
    # Mark daily block completion time
    echo "$_NOW_EPOCH" > "$_LAST_DAILY_FILE"
    echo "[run] daily block complete, next in ~24h"
  fi

  # ── Health check: scan new log lines for known error patterns ────────────
  CYCLE_TYPE=HEALTH node "$PROJECT_ROOT/runner/watchdog.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

  # ── Wait out the remainder of the 20-minute window ───────────────────────
  ELAPSED=$(( $(date +%s) - CYCLE_START ))
  WAIT=$(( BROWSE_INTERVAL - ELAPSED ))
  if [ "$WAIT" -gt 0 ]; then
    echo "[run] Cycle $CYCLE ($CYCLE_TYPE) done in ${ELAPSED}s. Next cycle in ${WAIT}s..."
    sleep "$WAIT"
  else
    echo "[run] Cycle $CYCLE ($CYCLE_TYPE) done in ${ELAPSED}s. Starting next cycle immediately."
    # Cycle ran far longer than expected — Mac likely woke from sleep.
    # Force a browser restart so the next cycle gets a fresh connection.
    if [ "$ELAPSED" -gt $(( BROWSE_INTERVAL * 2 )) ]; then
      echo "[run] post-sleep detected (elapsed=${ELAPSED}s) — restarting browser..."
      openclaw browser --browser-profile x-hunter stop >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
      sleep 3
      openclaw browser --browser-profile x-hunter start >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
      sleep 10
      echo "[run] browser restarted after sleep wake"
    fi
  fi
done
