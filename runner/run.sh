#!/bin/bash
# runner/run.sh — continuous agent loop
#
# Three-tier architecture:
#   Scraper loop (every 10 min, background): collect.js scrapes X feed via CDP,
#                                            scores posts, writes feed_digest.txt
#   Browse cycle (every 20 min, AI):        reads feed_digest.txt, takes notes,
#                                            updates ontology + trust_graph
#   Tweet cycle  (every 6th = 2 hrs, AI):  synthesizes notes, journals, tweets,
#                                            git push
#
# Press Ctrl+C to stop.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Singleton guard — kill any prior runner before starting ───────────────────
PIDFILE="$PROJECT_ROOT/runner/run.pid"
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[run] killing prior runner (pid $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null
    sleep 2
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

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
BROWSE_INTERVAL=1200  # 20 minutes in seconds
TWEET_EVERY=6         # tweet on cycles 6, 12, 18, ... (every 2 hours)
QUOTE_OFFSET=3        # quote-tweet on cycles 3, 9, 15, ... (midpoint between tweets)
TWEET_START=7         # earliest hour to post original tweets (0-23 UTC)
TWEET_END=23          # latest hour exclusive
CURIOSITY_EVERY=12    # refresh curiosity directive every ~4h (was 4)
GATEWAY_PORT=18789    # openclaw gateway WebSocket/HTTP port
CDP_PORT=18801        # Chrome DevTools Protocol port

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
agent_run() {
  openclaw agent "$@" &
  local PID=$!
  local elapsed=0
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
  return $?
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
        | grep -c '"type":"page"' || echo 0)
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

# Ensure browser is healthy: check → restart if broken → retry up to 3 times
# After a gateway restart, the openclaw browser control service needs ~15s to
# reconnect to Chrome, so we use a longer sleep when a restart is triggered.
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
    sleep 15  # openclaw browser control service needs ~15s to reconnect after restart
  done
  echo "[run] WARNING: browser unresponsive after 3 restart attempts — proceeding"
  return 1
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

while true; do
  CYCLE=$((CYCLE + 1))
  TODAY=$(date +%Y-%m-%d)
  NOW=$(date +%H:%M)
  HOUR=$(date +%H)
  CYCLE_START=$(date +%s)

  # Determine cycle type
  if [ $(( CYCLE % TWEET_EVERY )) -eq 0 ]; then
    CYCLE_TYPE="TWEET"
  elif [ $(( CYCLE % TWEET_EVERY )) -eq $QUOTE_OFFSET ]; then
    CYCLE_TYPE="QUOTE"
  else
    CYCLE_TYPE="BROWSE"
  fi

  # Suppress TWEET outside active hours -- downgrade to BROWSE
  if [ "$CYCLE_TYPE" = "TWEET" ]; then
    HOUR_INT=$(( 10#$HOUR ))
    if [ "$HOUR_INT" -lt "$TWEET_START" ] || [ "$HOUR_INT" -ge "$TWEET_END" ]; then
      echo "[run] Tweet window closed (hour=$HOUR), running as BROWSE"
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
  # ensure_browser only needed for TWEET (runner posts via CDP, not openclaw browser tool)
  if [ "$CYCLE_TYPE" = "TWEET" ]; then
    ensure_browser
  fi

  # ── Reset browse session periodically (every 6 cycles = 2h) ──────────────
  # Must restart gateway (not just wipe files) -- gateway caches session in memory.
  if [ $(( CYCLE % 6 )) -eq 0 ]; then
    reset_session x-hunter
    restart_gateway
    start_browser
    sleep 15  # browser control service needs ~15s after LaunchAgent restart
    check_browser && echo "[run] browser healthy after reset" || echo "[run] WARNING: browser still not ready after reset"
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
    agent_run --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking high \
      --verbose on

  # ── Browse cycle: read digest + topic summary, take notes ───────────────
  elif [ "$CYCLE_TYPE" = "BROWSE" ]; then
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

    NEXT_TWEET=$(( (CYCLE / TWEET_EVERY + 1) * TWEET_EVERY ))

    # Pre-fetch curiosity search URL in browser (non-blocking — page ready when agent starts)
    node "$PROJECT_ROOT/runner/prefetch_url.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Pre-load files into shell vars — agent skips read tool calls, goes straight to action
    # Backticks escaped to prevent accidental shell execution in heredoc expansion
    _BROWSE_NOTES=$(tail -n 80 "$PROJECT_ROOT/state/browse_notes.md" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _TOPIC_SUMMARY=$(cat "$PROJECT_ROOT/state/topic_summary.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(not yet generated)")
    _DIGEST=$(tail -n 160 "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(not yet generated)")
    _CRITIQUE=$(tail -n 12 "$PROJECT_ROOT/state/critique.md" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _CURIOSITY_DIRECTIVE=$(cat "$PROJECT_ROOT/state/curiosity_directive.txt" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _COMMENT_CANDIDATES=$(cat "$PROJECT_ROOT/state/comment_candidates.txt" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _DISCOURSE_DIGEST=$(cat "$PROJECT_ROOT/state/discourse_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _READING_URL=""
    _READING_FROM=""
    _READING_CONTEXT=""
    if [ -s "$PROJECT_ROOT/state/reading_url.txt" ]; then
      _READING_URL=$(grep "^URL:" "$PROJECT_ROOT/state/reading_url.txt" 2>/dev/null | sed 's/^URL: //' | sed "s/\`/'/g")
      _READING_FROM=$(grep "^FROM:" "$PROJECT_ROOT/state/reading_url.txt" 2>/dev/null | sed 's/^FROM: //' | sed "s/\`/'/g")
      _READING_CONTEXT=$(grep "^CONTEXT:" "$PROJECT_ROOT/state/reading_url.txt" 2>/dev/null | sed 's/^CONTEXT: //' | sed "s/\`/'/g")
    fi
    if [ -n "$_READING_URL" ]; then
      _READING_BLOCK="${_READING_FROM} recommended a link. Navigate to it as your FIRST task:
  ${_READING_URL}
  Context: ${_READING_CONTEXT}
  Read it. Note key claims in browse_notes.md. Integrate into belief notes."
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

    AGENT_MSG=$(cat <<BROWSEMSG
Today is $TODAY $NOW. Browse cycle $CYCLE -- no tweet this cycle.

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
── RECENT DISCOURSE (reply exchanges) ───────────────────────────────────
$_DISCOURSE_DIGEST
── READING QUEUE ────────────────────────────────────────────────────────
$_READING_BLOCK
─────────────────────────────────────────────────────────────────────────

Tasks (in order):
0. READING QUEUE: If there is a reading queue URL above (not "no reading queue item"),
   navigate to it FIRST. Read it carefully. Note key claims in browse_notes.md.
   Then proceed with the tasks below.
1. CURIOSITY: If the directive above has an ACTIVE SEARCH URL and you have not searched
   it this directive window, navigate to it now and read top 3-5 posts.
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
Next tweet cycle: $NEXT_TWEET.

BROWSEMSG
)
    agent_run --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

    # ── Mark reading queue item as done (agent has read it) ───────────────
    if [ -s "$PROJECT_ROOT/state/reading_url.txt" ]; then
      READING_CYCLE=$CYCLE node "$PROJECT_ROOT/runner/reading_queue.js" --mark-done \
        >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    # ── Merge ontology delta written by the browse agent ──────────────────
    node "$PROJECT_ROOT/runner/apply_ontology_delta.js" 2>&1 || true

    # ── Detect drift / change points in belief axes ────────────────────────
    node "$PROJECT_ROOT/runner/detect_drift.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

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

    AGENT_MSG=$(cat <<QUOTEMSG
Today is $TODAY $NOW. Quote cycle $CYCLE -- find one post worth quoting.

Already quoted source tweets (do NOT quote these again):
$QUOTED_SOURCES

── FEED DIGEST (most recent clusters) ───────────────────────────────────
$_DIGEST_QUOTE
─────────────────────────────────────────────────────────────────────────

Do NOT use any browser tools. Tasks:
1. From the digest above, pick the single most interesting post worth engaging with publicly.
   Criteria: genuine tension with your ontology, strong claim you can sharpen or challenge,
   or a signal moment others have not yet framed correctly.
   Each post line ends with its URL. SKIP any URL in the "already quoted" list above.
2. Write state/quote_draft.txt (overwrite):
   Line 1: the source tweet URL (exact URL from the digest, e.g. https://x.com/user/status/ID)
   Lines 2+: your one-sentence quote commentary. Direct, honest, max 240 chars.
   No hedging. This is your actual view.
3. Append to state/posts_log.json: type="quote", tweet_url="" (runner fills it in),
   source_url (the source tweet URL), text (your commentary), posted_at (ISO now).
4. Done -- the runner posts the quote. Do not use the browser.

QUOTEMSG
)
    rm -f "$PROJECT_ROOT/state/quote_draft.txt" "$PROJECT_ROOT/state/quote_result.txt"
    agent_run --agent x-hunter-tweet \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

    # ── Post quote-tweet via CDP (runner handles, no browser tool needed) ──────
    if [ -f "$PROJECT_ROOT/state/quote_draft.txt" ]; then
      echo "[run] Posting quote-tweet via CDP..."
      node "$PROJECT_ROOT/runner/post_quote.js" 2>&1
      QUOTE_URL=$(cat "$PROJECT_ROOT/state/quote_result.txt" 2>/dev/null | tr -d '\n')
      if [ -n "$QUOTE_URL" ] && [ "$QUOTE_URL" != "posted" ]; then
        node -e "
          const fs=require('fs'),p='$PROJECT_ROOT/state/posts_log.json';
          try {
            const d=JSON.parse(fs.readFileSync(p,'utf-8'));
            const posts=d.posts||[];
            for(let i=posts.length-1;i>=0;i--){
              if(posts[i].type==='quote'&&!posts[i].tweet_url){
                posts[i].tweet_url='$QUOTE_URL'; break;
              }
            }
            fs.writeFileSync(p,JSON.stringify(d,null,2));
          } catch(e){}
        " 2>/dev/null
        echo "[run] Quote posted: $QUOTE_URL"
      fi
    else
      echo "[run] No quote_draft.txt — agent did not produce a quote"
    fi

    # Coherence critique of the quote tweet
    node "$PROJECT_ROOT/runner/critique.js" --quote --cycle "$CYCLE" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

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

    # Pre-load files — agent skips read tool calls
    _BROWSE_NOTES_FULL=$(cat "$PROJECT_ROOT/state/browse_notes.md" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _MEMORY_RECALL=$(cat "$PROJECT_ROOT/state/memory_recall.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _DISCOURSE_DIGEST_TWEET=$(cat "$PROJECT_ROOT/state/discourse_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(no discourse yet)")
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

    AGENT_MSG=$(cat <<TWEETMSG
Today is $TODAY $NOW. Tweet cycle $CYCLE -- FILE-ONLY. No browser tool at any point.

All files are pre-loaded below. Do NOT call any read_file tools.

── BROWSE NOTES ─────────────────────────────────────────────────────────
$_BROWSE_NOTES_FULL
── MEMORY RECALL ────────────────────────────────────────────────────────
$_MEMORY_RECALL
── CURRENT BELIEF AXES (read before updating ontology) ──────────────────
$_CURRENT_AXES_TWEET
── RECENT DISCOURSE (reply exchanges) ───────────────────────────────────
$_DISCOURSE_DIGEST_TWEET
─────────────────────────────────────────────────────────────────────────

Tasks (in order, no browser):
1. Synthesize: the single clearest insight, tension, or question from this window.
2. Write journals/${TODAY}_${HOUR}.html
3. Draft tweet: one sentence, honest and direct.
   Add journal URL on new line: https://sebastianhunter.fun/journal/${TODAY}/${HOUR}
   Total <= 280 chars. Self-check (AGENTS.md 13.3) -- write SKIP if not genuine.
4. Write state/tweet_draft.txt (plain text, overwrite).
5. Append to state/posts_log.json (tweet_url="" for now, runner fills it in).
6. Write state/ontology_delta.json if the synthesis adds new evidence.
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
7. Clear state/browse_notes.md (overwrite with empty string).

TWEETMSG
)
    rm -f "$PROJECT_ROOT/state/tweet_draft.txt" "$PROJECT_ROOT/state/tweet_result.txt"
    agent_run --agent x-hunter-tweet \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

    # ── Merge ontology delta written by the tweet agent ───────────────────
    node "$PROJECT_ROOT/runner/apply_ontology_delta.js" 2>&1 || true

    # ── Detect drift / change points in belief axes ────────────────────────
    node "$PROJECT_ROOT/runner/detect_drift.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # ── Post tweet via CDP (no browser tool needed from agent) ──────────────
    if [ -f "$PROJECT_ROOT/state/tweet_draft.txt" ]; then
      DRAFT=$(cat "$PROJECT_ROOT/state/tweet_draft.txt")
      if [ "$DRAFT" = "SKIP" ]; then
        echo "[run] Agent chose to skip tweet this cycle (self-check failed)"
      else
        echo "[run] Posting tweet via CDP..."
        node "$PROJECT_ROOT/runner/post_tweet.js" 2>&1
        TWEET_URL=$(cat "$PROJECT_ROOT/state/tweet_result.txt" 2>/dev/null | tr -d '\n')
        if [ -n "$TWEET_URL" ] && [ "$TWEET_URL" != "posted" ]; then
          echo "[run] Tweet posted: $TWEET_URL"
          # Patch posts_log.json with the real tweet URL
          node -e "
            try {
              const fs=require('fs'), p='$PROJECT_ROOT/state/posts_log.json';
              const log=JSON.parse(fs.readFileSync(p,'utf-8'));
              const last=log.posts[log.posts.length-1];
              if(last && !last.tweet_url) { last.tweet_url='$TWEET_URL'; last.posted_at=new Date().toISOString(); }
              fs.writeFileSync(p,JSON.stringify(log,null,2));
              console.log('[run] posts_log.json updated with tweet_url');
            } catch(e) { console.error('[run] posts_log patch failed:', e.message); }
          " 2>&1 || true
        else
          echo "[run] Tweet posted (URL not captured or post_tweet.js failed)"
        fi
      fi
    else
      echo "[run] No tweet_draft.txt — agent did not produce a draft"
    fi

    # ── Validate + restore state files if agent wrote malformed JSON ──────────
    for _sf in posts_log ontology belief_state; do
      _fp="$PROJECT_ROOT/state/${_sf}.json"
      if [ -f "$_fp" ]; then
        if ! node -e "JSON.parse(require('fs').readFileSync('$_fp','utf-8'))" 2>/dev/null; then
          echo "[run] WARNING: ${_sf}.json is malformed — restoring from .bak"
          [ -f "${_fp}.bak" ] && cp "${_fp}.bak" "$_fp" || true
        fi
      fi
    done

    # ── Git commit and push ─────────────────────────────────────────────────
    git -C "$PROJECT_ROOT" add journals/ checkpoints/ state/ 2>/dev/null || true
    git -C "$PROJECT_ROOT" commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}" 2>/dev/null || true
    git -C "$PROJECT_ROOT" push origin main 2>/dev/null || true
    echo "[run] git push done"

    # Archive new journals/checkpoints to Irys + local memory index
    node "$PROJECT_ROOT/runner/archive.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    # Daily maintenance (every 24h = 72 cycles)
    if [ $(( CYCLE % (TWEET_EVERY * 12) )) -eq 0 ]; then
      # ── Daily belief report ──────────────────────────────────────────────────
      node "$PROJECT_ROOT/runner/generate_daily_report.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
      # ── Checkpoint (every 3 days — generate_checkpoint.js self-gates) ───────
      node "$PROJECT_ROOT/runner/generate_checkpoint.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
      # Trim feed_digest.txt to last 3000 lines (~2-3 days of data)
      DLINES=$(wc -l < "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null || echo 0)
      if [ "$DLINES" -gt 3000 ]; then
        tail -n 3000 "$PROJECT_ROOT/state/feed_digest.txt" > /tmp/hunter_digest_trim \
          && mv /tmp/hunter_digest_trim "$PROJECT_ROOT/state/feed_digest.txt"
        echo "[run] trimmed feed_digest.txt: ${DLINES} → 3000 lines"
      fi
      # Delete local journal HTML files older than 7 days (already on Arweave)
      find "$PROJECT_ROOT/journals/" -name "*.html" -mtime +7 -delete 2>/dev/null \
        && echo "[run] pruned local journals older than 7 days" || true
      # Rotate logs: keep last 5000 lines of runner.log, 3000 of scraper.log
      for _log_pair in "$PROJECT_ROOT/runner/runner.log:5000" "$PROJECT_ROOT/scraper/scraper.log:3000"; do
        _lf="${_log_pair%%:*}"; _lk="${_log_pair##*:}"
        if [ -f "$_lf" ]; then
          tail -n "$_lk" "$_lf" > "${_lf}.tmp" && mv "${_lf}.tmp" "$_lf"
          echo "[run] rotated $(basename "$_lf") to last ${_lk} lines"
        fi
      done
    fi

    # Coherence critique of the journal + tweet (only if agent actually posted this cycle)
    node "$PROJECT_ROOT/runner/critique.js" --cycle "$CYCLE" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
  fi

  # ── Wait out the remainder of the 20-minute window ───────────────────────
  ELAPSED=$(( $(date +%s) - CYCLE_START ))
  WAIT=$(( BROWSE_INTERVAL - ELAPSED ))
  if [ "$WAIT" -gt 0 ]; then
    echo "[run] Cycle $CYCLE ($CYCLE_TYPE) done in ${ELAPSED}s. Next cycle in ${WAIT}s..."
    sleep "$WAIT"
  else
    echo "[run] Cycle $CYCLE ($CYCLE_TYPE) done in ${ELAPSED}s. Starting next cycle immediately."
  fi
done
