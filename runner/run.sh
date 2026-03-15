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
caffeinate -sd -w $$ &
CAFFEINATE_PID=$!
echo "[run] caffeinate started (PID=$CAFFEINATE_PID) — Mac sleep disabled"

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
    AGENT_MSG=$(cat <<FIRSTMSG
Today is $TODAY $NOW. This is the very first run -- total_posts is 0.

Follow BOOTSTRAP.md section 6 (profile setup) and 6b (seed tweet) and 6c (intro tweet) first.

After the intro tweet, do a first browse pass:
1. Read state/browse_notes.md (empty on first run).
2. Navigate to https://x.com -- scroll the feed, read at least 15 posts end to end.
3. Click into at least 3 threads that catch your attention and read the replies.
4. Navigate to https://x.com/search?q=... on 2 topics that interested you and read 10 more posts each.
5. Append everything notable to state/browse_notes.md (quotes, tensions, source URLs).
6. Update state/ontology.json if anything is axis-worthy.
7. Done -- do not tweet again this cycle.

FIRSTMSG
)
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

    NEXT_TWEET=$(( (CYCLE / TWEET_EVERY + 1) * TWEET_EVERY ))

    # Pre-fetch curiosity search URL in browser (non-blocking — page ready when agent starts)
    PREFETCH_CYCLE=$CYCLE node "$PROJECT_ROOT/runner/prefetch_url.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Pre-load files into shell vars — agent skips read tool calls, goes straight to action
    # Backticks escaped to prevent accidental shell execution in heredoc expansion
    _BROWSE_NOTES=$(tail -n 80 "$PROJECT_ROOT/state/browse_notes.md" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _TOPIC_SUMMARY=$(cat "$PROJECT_ROOT/state/topic_summary.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(not yet generated)")
    _DIGEST=$(tail -n 160 "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(not yet generated)")
    _CRITIQUE=$(tail -n 12 "$PROJECT_ROOT/state/critique.md" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _CURIOSITY_DIRECTIVE=$(cat "$PROJECT_ROOT/state/curiosity_directive.txt" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _COMMENT_CANDIDATES=$(cat "$PROJECT_ROOT/state/comment_candidates.txt" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _DISCOURSE_DIGEST=$(cat "$PROJECT_ROOT/state/discourse_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _SPRINT_CONTEXT=$(cat "$PROJECT_ROOT/state/sprint_context.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(no active plan)")
    _READING_URL=""
    _READING_FROM=""
    _READING_CONTEXT=""
    if [ -s "$PROJECT_ROOT/state/reading_url.txt" ]; then
      _READING_URL=$(grep "^URL:" "$PROJECT_ROOT/state/reading_url.txt" 2>/dev/null | sed 's/^URL: //' | sed "s/\`/'/g")
      _READING_FROM=$(grep "^FROM:" "$PROJECT_ROOT/state/reading_url.txt" 2>/dev/null | sed 's/^FROM: //' | sed "s/\`/'/g")
      _READING_CONTEXT=$(grep "^CONTEXT:" "$PROJECT_ROOT/state/reading_url.txt" 2>/dev/null | sed 's/^CONTEXT: //' | sed "s/\`/'/g")
    fi
    if [ -n "$_READING_URL" ]; then
      # Detect profile deep dive vs article/content link
      if echo "$_READING_URL" | grep -qE "^https://x\.com/[A-Za-z0-9_]+/?$"; then
        # Profile URL — richer deep dive instructions
        _PROFILE_HANDLE=$(echo "$_READING_URL" | sed 's|https://x.com/||;s|/||g')
        _READING_BLOCK="${_READING_FROM} asked you to learn about @${_PROFILE_HANDLE}. DEEP DIVE — this is your primary task this cycle:
  URL: ${_READING_URL}
  Context: ${_READING_CONTEXT}

  Do all of the following:
  1. Navigate to their profile. Read their pinned tweet and bio.
  2. Scroll their timeline — read at least 8 recent tweets. Note their main positions,
     recurring themes, and any tensions or contradictions.
  3. Check if their views connect to any of your current belief axes. Note evidence.
  4. Search for '@${_PROFILE_HANDLE}' to see how others engage with them (optional if time allows).
  5. Write a dedicated section in browse_notes.md: '## Deep Dive: @${_PROFILE_HANDLE}'
     Summarise what you learned and whether it shifted any of your beliefs."
      else
        # Article / content URL
        _READING_BLOCK="${_READING_FROM} recommended a link. Navigate to it as your FIRST task:
  ${_READING_URL}
  Context: ${_READING_CONTEXT}
  Read it carefully. Note key claims, evidence quality, and any tensions with your current axes.
  Write findings in browse_notes.md under '## Reading: ${_READING_URL}'"
      fi
    else
      _READING_BLOCK="(no reading queue item this cycle)"
    fi
    _CURRENT_AXES=$(node -e "
      try {
        const d=JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/state/ontology.json','utf-8'));
        (d.axes||[]).forEach(a=>{
          const ev=(a.evidence_log||[]).length;
          const conf=((a.confidence||0)*100).toFixed(0);
          console.log('  ['+a.id+'] '+a.label+' (conf:'+conf+'%, ev:'+ev+')');
          console.log('    L: '+a.left_pole.slice(0,80));
          console.log('    R: '+a.right_pole.slice(0,80));
        });
      } catch(e){ console.log('  (could not read ontology.json: '+e.message+')'); }
    " 2>/dev/null || echo "  (none yet)")

    # Journal task: only if no journal file exists for this hour yet
    _BROWSE_JOURNAL_PATH="$PROJECT_ROOT/journals/${TODAY}_${HOUR}.html"
    if [ -f "$_BROWSE_JOURNAL_PATH" ]; then
      _JOURNAL_TASK="journals/${TODAY}_${HOUR}.html ALREADY EXISTS. DO NOT write or overwrite this file under any circumstances — it has been permanently archived to Arweave and cannot be changed."
    else
      _JOURNAL_TASK="Write journals/${TODAY}_${HOUR}.html now. This is Day $DAY_NUMBER.
   Brief observation log for this browse cycle — 150-200 words.
   One or two key tensions or signals you noticed. What is new or surprising.
   Use standard HTML journal format (same as tweet cycle journals).
   In the HTML metadata use content=\"$DAY_NUMBER\" for x-hunter-day and \"Day $DAY_NUMBER · Hour $HOUR\" in the header.
   This is the public record of what you observed. Keep it honest and specific."
    fi

    AGENT_MSG=$(cat <<BROWSEMSG
Today is $TODAY $NOW — Day $DAY_NUMBER. Browse cycle $CYCLE -- no tweet this cycle.

All files are pre-loaded below. Do NOT call any read_file tools.
Proceed directly to tasks.

Digest format:
  CLUSTER N . "label" . M posts [. TRENDING]
    @user [vSCORE TTRUST NNOVELTY] "text"  {keywords}
  v=velocity  T=trust(0-10)  N=novelty(0-5, 5=rarest)  TRENDING=doubled vs prev window
  <- novel = singleton with N>=4.0

── BROWSE NOTES (recent) ────────────────────────────────────────────────
$_BROWSE_NOTES
── LAST CRITIQUE ────────────────────────────────────────────────────────
$_CRITIQUE
── TOPIC SUMMARY (last 4h) ──────────────────────────────────────────────
$_TOPIC_SUMMARY
── FEED DIGEST (most recent clusters) ───────────────────────────────────
$_DIGEST
── CURIOSITY DIRECTIVE ──────────────────────────────────────────────────
$_CURIOSITY_DIRECTIVE
── COMMENT CANDIDATES ───────────────────────────────────────────────────
$_COMMENT_CANDIDATES
── CURRENT BELIEF AXES (read before updating ontology) ──────────────────
$_CURRENT_AXES
── SPRINT PLAN (your active tasks — focus browsing here) ─────────────────
$_SPRINT_CONTEXT
── RECENT DISCOURSE (reply exchanges) ───────────────────────────────────
$_DISCOURSE_DIGEST
── READING QUEUE ────────────────────────────────────────────────────────
$_READING_BLOCK
─────────────────────────────────────────────────────────────────────────

Tasks (in order):
0. DEEP DIVE (highest priority): If there is a reading queue item above, follow
   those instructions completely before anything else. A deep dive on a profile or link
   takes the full cycle — skip task 1 (curiosity search) if you did a deep dive.
1. CURIOSITY: If NO deep dive this cycle and the directive above has an ACTIVE SEARCH URL,
   navigate to it now and read top 3-5 posts. Each cycle in the window searches a
   different angle — check which SEARCH_URL_N is preloaded in your browser.
   For ALL browse cycles while the directive is active: follow the AMBIENT FOCUS —
   tag relevant browse_notes entries with [CURIOSITY: <axis_or_topic_id>].
2. Identify the 3-5 most interesting tensions or signals from TRENDING clusters
   and <- novel singletons. You may navigate to at most 1 additional URL.
3. Append findings to state/browse_notes.md (append only -- do not overwrite).
4. Write state/ontology_delta.json if anything is genuinely axis-worthy.
   DO NOT write or modify state/ontology.json directly — the runner merges your delta.
   ONTOLOGY RULES (CURRENT BELIEF AXES shown above — do not alter existing data):
   a. Fit new evidence to an existing axis before creating a new one.
      Use the axis_id shown in the CURRENT BELIEF AXES list.
   b. Create a new axis ONLY if the topic is genuinely orthogonal to all
      existing axes AND the pattern appeared in at least 2 browse cycles.
   c. NEVER touch or rewrite state/ontology.json — your job is delta only.
   d. Merge proposals: if two axes cover the same ground, append one JSON line to
      state/ontology_merge_proposals.txt (axis_a, axis_b, reason, proposed_surviving_id).
      Do NOT merge directly.

   Delta format — write state/ontology_delta.json as:
   {
     "evidence": [
       { "axis_id": "<existing_axis_id>", "source": "<url>",
         "content": "<one sentence>", "timestamp": "<ISO>",
         "pole_alignment": "left" | "right" }
     ],
     "new_axes": [
       { "id": "<snake_case_id>", "label": "<label>",
         "left_pole": "<description>", "right_pole": "<description>" }
     ]
   }
   Omit "evidence" or "new_axes" if nothing to add. Skip writing the file entirely
   if nothing is axis-worthy this cycle.

5. Review COMMENT CANDIDATES above. Comment on AT MOST ONE if your memory gives
   you something genuinely specific to say — a direct observation, contradiction,
   or angle not yet in the thread. Skip all if nothing compels you or cap reached.
   If commenting: navigate to the URL, reply (max 180 chars), then write
   state/comment_done.txt as a single JSON line per the format in the candidates.
6. JOURNAL: $_JOURNAL_TASK
Next tweet cycle: $NEXT_TWEET.

BROWSEMSG
)
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
    # Build a compact list of already-quoted source URLs for dedup
    QUOTED_SOURCES=$(node -e "
      const fs=require('fs'), p='$PROJECT_ROOT/state/posts_log.json';
      try {
        const posts=JSON.parse(fs.readFileSync(p,'utf-8')).posts||[];
        const quotes=posts.filter(p=>p.type==='quote'&&p.source_url);
        if(quotes.length===0){process.stdout.write('(none yet)');process.exit(0);}
        process.stdout.write(quotes.map(q=>'- '+q.source_url).join('\n'));
      } catch(e){process.stdout.write('(none yet)');}
    " 2>/dev/null || echo "(none yet)")
    # Pre-load digest snippet for quote cycle
    _DIGEST_QUOTE=$(tail -n 120 "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(not available)")
    # Pre-load top belief axes for grounding the quote (full poles + recent evidence)
    _TOP_AXES=$(node -e "
      try {
        const o=JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/state/ontology.json','utf-8'));
        const raw=Array.isArray(o.axes)?o.axes:Object.values(o.axes||{});
        const axes=raw
          .filter(a=>a.confidence>=0.65)
          .sort((a,b)=>b.confidence-a.confidence)
          .slice(0,6);
        const out=axes.map(a=>{
          const ev=(a.evidence_log||[]).slice(-2).map(e=>'    * '+e.content.slice(0,120)).join('\n');
          return '- '+a.label+' (conf: '+(a.confidence*100).toFixed(0)+'%)\n'+
                 '  LEFT: '+a.left_pole+'\n'+
                 '  RIGHT: '+a.right_pole+
                 (ev?'\n  Recent evidence:\n'+ev:'');
        });
        process.stdout.write(out.join('\n\n'));
      } catch(e){process.stdout.write('(unavailable)');}
    " 2>/dev/null || echo "(unavailable)")

    AGENT_MSG=$(cat <<QUOTEMSG
Today is $TODAY $NOW. Quote cycle $CYCLE -- find one post worth quoting.

Your strongest belief axes (what you actually think matters):
$_TOP_AXES

Already quoted source tweets (do NOT quote these again):
$QUOTED_SOURCES

── FEED DIGEST (most recent clusters) ───────────────────────────────────
$_DIGEST_QUOTE
─────────────────────────────────────────────────────────────────────────

Tasks:
1. From the digest above, identify 2-3 candidate posts that touch your belief axes.
   HARD SKIP (never quote these): questions or replies directed AT you (@SebastianHunts),
   retweets with no original text, posts that are only a URL, posts shorter than 15 words.
   Candidates must be making a real substantive claim you can engage with.

2. Navigate to the best candidate URL in your browser. Read the actual tweet and its visible replies.
   Do not rely on the digest summary — you need to see what the tweet actually says in full.
   While reading, ask: does this push left or right on one of my axes? Does it confirm my prior,
   challenge it, or reveal a nuance I had not seen? That specific tension is your angle.
   If after reading it is not interesting enough to quote, navigate to your second candidate.

3. Write your quote commentary ONLY after you have read the tweet in the browser.
   NOT acceptable: generic belief statement that could apply to any tweet.
   NOT acceptable: "this claim conflates X", "demands scrutiny", "risks premature judgment" — press release language.
   NOT acceptable: internal metrics in the tweet — no "conf 95%", "score 0.40", "(confidence: X)".
   ACCEPTABLE: a direct response to what this specific tweet actually says, from your position on the axis.
   The reader must be able to see why THIS tweet provoked THIS response. Max 240 chars.
   VOICE: Write like a person, not an analyst. Short, direct sentences. Say what the tweet
   claims, then say what you actually think about it. If it sounds like a report, rewrite it.

4. Write state/quote_draft.txt (overwrite):
   Line 1: the source tweet URL
   Lines 2+: your quote commentary (max 240 chars).
   Do NOT write to state/posts_log.json — the runner owns that file.

5. Done — do not navigate further. The runner posts the quote.

QUOTEMSG
)
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

    # Pre-load files — agent skips read tool calls
    _BROWSE_NOTES_FULL=$(cat "$PROJECT_ROOT/state/browse_notes.md" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _MEMORY_RECALL=$(cat "$PROJECT_ROOT/state/memory_recall.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _DISCOURSE_DIGEST_TWEET=$(cat "$PROJECT_ROOT/state/discourse_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(no discourse yet)")
    # Load sprint context (written by sprint_manager.js, or fallback to active_plan.json)
    if [ -f "$PROJECT_ROOT/state/sprint_context.txt" ]; then
      _ACTIVE_PLAN_CONTEXT=$(cat "$PROJECT_ROOT/state/sprint_context.txt" 2>/dev/null | sed "s/\`/'/g")
    else
      _ACTIVE_PLAN_CONTEXT=$(node -e "
        try {
          const a=JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/state/active_plan.json','utf-8'));
          if (a && a.status==='active') {
            console.log('ACTIVE PLAN: ' + a.title);
            console.log('Goal: ' + (a.first_sprint?.week_1_goal || '(none)'));
            const days = Math.floor((Date.now()-new Date(a.activated_date).getTime())/86400000);
            console.log('Day ' + days + ' of 30');
          } else { console.log('(no active plan)'); }
        } catch(e){ console.log('(no active plan)'); }
      " 2>/dev/null || echo "(no active plan)")
    fi
    _CURRENT_AXES_TWEET=$(node -e "
      try {
        const d=JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/state/ontology.json','utf-8'));
        (d.axes||[]).forEach(a=>{
          const ev=(a.evidence_log||[]).length;
          const conf=((a.confidence||0)*100).toFixed(0);
          console.log('  ['+a.id+'] '+a.label+' (conf:'+conf+'%, ev:'+ev+')');
          console.log('    L: '+a.left_pole.slice(0,80));
          console.log('    R: '+a.right_pole.slice(0,80));
        });
      } catch(e){ console.log('  (could not read ontology.json: '+e.message+')'); }
    " 2>/dev/null || echo "  (none yet)")

    # Journal task for tweet cycle: hard guard if file already exists
    _TWEET_JOURNAL_PATH="$PROJECT_ROOT/journals/${TODAY}_${HOUR}.html"
    if [ -f "$_TWEET_JOURNAL_PATH" ]; then
      _TWEET_JOURNAL_TASK="journals/${TODAY}_${HOUR}.html ALREADY EXISTS. DO NOT write or overwrite this file — it has been permanently archived to Arweave."
    else
      _TWEET_JOURNAL_TASK="Write journals/${TODAY}_${HOUR}.html (Day $DAY_NUMBER). Use x-hunter-day content=\"$DAY_NUMBER\" and \"Day $DAY_NUMBER · Hour $HOUR\" in the header."
    fi

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

    AGENT_MSG=$(cat <<TWEETMSG
Today is $TODAY $NOW — Day $DAY_NUMBER. Tweet cycle $CYCLE -- FILE-ONLY. No browser tool at any point.

All files are pre-loaded below. Do NOT call any read_file tools.

── BROWSE NOTES ─────────────────────────────────────────────────────────
$_BROWSE_NOTES_FULL
── MEMORY RECALL ────────────────────────────────────────────────────────
$_MEMORY_RECALL
── CURRENT BELIEF AXES (read before updating ontology) ──────────────────
$_CURRENT_AXES_TWEET
── SPRINT PLAN (your current 30-day commitment + weekly tasks) ────────────
$_ACTIVE_PLAN_CONTEXT
── RECENT DISCOURSE (reply exchanges) ───────────────────────────────────
$_DISCOURSE_DIGEST_TWEET
─────────────────────────────────────────────────────────────────────────

Tasks (in order, no browser):
1. Axis prediction check — for each of your top 3 belief axes, state in one phrase what you
   expected to see today based on your current score and direction. Then check: did the browse
   notes confirm it, challenge it, or show something orthogonal? The most interesting tweet
   lives at that gap — where a prior was updated, reversed, or sharpened by something concrete.
2. $_TWEET_JOURNAL_TASK
3. Draft tweet from the most interesting gap found in task 1.
   Requirements (ALL must be met — if you cannot satisfy them, write SKIP):
   a. Concrete reference: must name something specific observed in the browse notes —
      a specific account, a claim someone actually made, a statistic, or a named event.
      No abstract observations about "AI" or "institutions" in general.
   b. Falsifiable: a thoughtful person should be able to disagree with it.
      If it reads as obviously true to everyone, it is not a real position — reframe or SKIP.
   c. Self-check (AGENTS.md 13.3) — if not genuine, SKIP.
   d. If browse notes indicate the browser was unavailable, no feed was loaded, or no
      specific observations were made this cycle — write SKIP. Do NOT invent insights
      from prior memory or general knowledge. The tweet must be grounded in THIS cycle.
   Better no tweet than a weak one.
   e. If you have an active plan, you may reference it when relevant — connecting what
      you observed to your plan domain is encouraged, but only if the link is genuine.
      Do NOT force every tweet to be about the plan. Authenticity first.
   VOICE (mandatory — rewrite until these are met):
   f. NEVER include confidence scores, axis scores, or internal metrics in the tweet.
      No "conf 95%", "score 0.40", "(confidence: X)" — these are internal state, not speech.
   g. Write like a person, not an analyst. Use short, direct sentences.
      BAD: "This directly challenges the integrity of public discourse."
      GOOD: "Four different accounts said the video was fake. None linked a source."
   h. Name what you actually saw — paraphrase a claim, quote a tension, describe
      the specific thing that caught your attention. Abstract pattern labels
      ("strategic narrative", "emotional manipulation") are not tweets — they are
      summaries. Say what happened, then say what you think about it.
   i. Read your draft aloud in your head. If it sounds like a report or a system
      log, rewrite it until it sounds like something a thoughtful person would say
      over coffee.
4. Write state/tweet_draft.txt (plain text, overwrite):
   Line 1: your insight sentence (REQUIRED — must not be empty)
   Line 2: https://sebastianhunter.fun/journal/${TODAY}/${HOUR}
   Total length <= 280 chars. Do NOT write only the URL — if line 1 is empty the tweet is worthless.
   Do NOT write to state/posts_log.json — the runner owns that file.
5. Write state/ontology_delta.json if the synthesis adds new evidence.
   Also update state/belief_state.json.
   DO NOT write or modify state/ontology.json directly — the runner merges your delta.
   ONTOLOGY RULES (CURRENT BELIEF AXES shown above — do not alter existing data):
   a. Fit new evidence to an existing axis using the axis_id from the list above.
   b. Create a new axis ONLY if genuinely orthogonal AND seen in 2+ browse cycles.
   c. Merge proposals only: append to state/ontology_merge_proposals.txt if two axes
      overlap (axis_a, axis_b, reason, proposed_surviving_id). Never merge directly.
   Delta format — write state/ontology_delta.json as:
   { "evidence": [{ "axis_id":"...", "source":"...", "content":"...",
                    "timestamp":"...", "pole_alignment":"left"|"right" }],
     "new_axes": [{ "id":"...", "label":"...", "left_pole":"...", "right_pole":"..." }] }
   Omit keys you do not need. Skip writing the file if nothing axis-worthy.
6. Done. The runner clears browse_notes.md after this cycle.

TWEETMSG
)
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
    ensure_browser
    if [ -f "$PROJECT_ROOT/state/article_result.txt" ]; then
      _ARTICLE_URL=$(sed -n '1p' "$PROJECT_ROOT/state/article_result.txt" | tr -d '\n')
      _ARTICLE_TITLE=$(sed -n '2p' "$PROJECT_ROOT/state/article_result.txt" | tr -d '\n')
      # Truncate title to fit: "New piece: TITLE → URL" within 280 chars
      _MAX_TITLE=$(( 240 - ${#_ARTICLE_URL} ))
      if [ ${#_ARTICLE_TITLE} -gt $_MAX_TITLE ]; then
        _ARTICLE_TITLE="${_ARTICLE_TITLE:0:$_MAX_TITLE}..."
      fi
      printf "New piece: %s\n%s" "$_ARTICLE_TITLE" "$_ARTICLE_URL" > "$PROJECT_ROOT/state/tweet_draft.txt"
      echo "[run] tweeting article link: $_ARTICLE_URL"
      _TWEET_OUT=$(node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1)
      _TWEET_RC=$?
      echo "$_TWEET_OUT" | grep -v '^$'
      if [ "$_TWEET_RC" -eq 0 ]; then
        rm -f "$PROJECT_ROOT/state/article_result.txt"
      else
        echo "[run] article tweet failed (rc=$_TWEET_RC) — keeping article_result.txt for retry"
      fi
      sleep 10  # rate-limit gap before next tweet
    fi
    # ── Checkpoint (every 3 days — generate_checkpoint.js self-gates) ───────
    node "$PROJECT_ROOT/runner/generate_checkpoint.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
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
      sleep 10  # rate-limit gap
    fi
    # ── Ponder (fires after checkpoint if conviction threshold met) ───────────
    node "$PROJECT_ROOT/runner/ponder.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    # Post plan announcement tweet if decision.js activated a plan
    if [ -f "$PROJECT_ROOT/state/plan_tweet.txt" ]; then
      cp "$PROJECT_ROOT/state/plan_tweet.txt" "$PROJECT_ROOT/state/tweet_draft.txt"
      node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1 | grep -v '^$' || true
      rm -f "$PROJECT_ROOT/state/plan_tweet.txt"
      echo "[run] plan announcement tweet posted"
      sleep 10  # rate-limit gap
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
