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
if [ -n "$GITHUB_TOKEN" ]; then
  REPO_URL="https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
  git -C "$PROJECT_ROOT" remote set-url origin "$REPO_URL" 2>/dev/null || true
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
# Clear stale curiosity file from any previous run so the agent never acts on old data
rm -f "$PROJECT_ROOT/state/curiosity_seeds.txt"

CYCLE=0
BROWSE_INTERVAL=1200  # 20 minutes in seconds
TWEET_EVERY=6         # tweet on cycles 6, 12, 18, ... (every 2 hours)
QUOTE_OFFSET=3        # quote-tweet on cycles 3, 9, 15, ... (midpoint between tweets)
TWEET_START=7         # earliest hour to post original tweets (0-23 UTC)
TWEET_END=23          # latest hour exclusive
CURIOSITY_EVERY=4     # curiosity search on browse cycles 4, 8, 16, ...
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
      return 0
    fi
  done
  echo "[run] WARNING: browser CDP not ready after 30s — proceeding"
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

  # ── Clean stale lock files from any interrupted previous cycle ────────────
  clean_stale_locks

  # ── Ensure browser is alive before each cycle ────────────────────────────
  openclaw browser --browser-profile x-hunter start 2>/dev/null || true
  sleep 1

  # ── Before tweet/quote cycles: restart gateway + browser to get a clean
  #    browser control service state. Uses health polling instead of fixed sleeps.
  #    Also reset x-hunter-tweet session -- it fills fast (373KB digest/cycle)
  if [ "$CYCLE_TYPE" = "TWEET" ] || [ "$CYCLE_TYPE" = "QUOTE" ]; then
    reset_session x-hunter-tweet  # flush BEFORE gateway restart so gateway loads clean state
    restart_gateway               # kill + start + poll health (~10s vs 60s)
    start_browser                 # stop + start + poll CDP port for readiness
    sleep 5                       # let gateway register browser control service
    echo "[run] gateway + browser hard-restarted before $CYCLE_TYPE cycle"
  fi

  # ── Reset browse session periodically (every 6 cycles = 2h) ──────────────
  # Must restart gateway (not just wipe files) -- gateway caches session in memory.
  if [ $(( CYCLE % 6 )) -eq 0 ]; then
    reset_session x-hunter
    restart_gateway
    openclaw browser --browser-profile x-hunter start 2>/dev/null || true
    sleep 3
    echo "[run] x-hunter session + gateway restarted (context flush cycle $CYCLE)"
  fi

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
    RECALL_QUERY=$(grep -oP '\d+x\s+\K.+' "$PROJECT_ROOT/state/topic_summary.txt" 2>/dev/null | head -3 | tr '\n' ' ' | xargs)
    if [ -n "$RECALL_QUERY" ]; then
      node "$PROJECT_ROOT/runner/recall.js" --query "$RECALL_QUERY" --limit 5 >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    else
      node "$PROJECT_ROOT/runner/recall.js" --limit 5 >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    # Curiosity seeds: LLM picks best keyword (from top scraped) every 4th browse cycle
    if [ $(( CYCLE % CURIOSITY_EVERY )) -eq 0 ]; then
      node "$PROJECT_ROOT/runner/curiosity.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
    fi

    NEXT_TWEET=$(( (CYCLE / TWEET_EVERY + 1) * TWEET_EVERY ))

    # Pre-load files into shell vars — agent skips read tool calls, goes straight to action
    # Backticks escaped to prevent accidental shell execution in heredoc expansion
    _BROWSE_NOTES=$(tail -n 80 "$PROJECT_ROOT/state/browse_notes.md" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _TOPIC_SUMMARY=$(cat "$PROJECT_ROOT/state/topic_summary.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(not yet generated)")
    _DIGEST=$(tail -n 160 "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(not yet generated)")
    _CRITIQUE=$(tail -n 12 "$PROJECT_ROOT/state/critique.md" 2>/dev/null | sed "s/\`/'/g" || echo "")
    _CURIOSITY=$(cat "$PROJECT_ROOT/state/curiosity_seeds.txt" 2>/dev/null | sed "s/\`/'/g" || echo "")

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
── CURIOSITY SEED ───────────────────────────────────────────────────────
$_CURIOSITY
─────────────────────────────────────────────────────────────────────────

Tasks (in order):
1. If a curiosity Search URL is present above, navigate to it. Read top 3 posts.
2. Identify the 3-5 most interesting tensions or signals from TRENDING clusters
   and <- novel singletons. You may navigate to at most 1 additional URL.
3. Append findings to state/browse_notes.md (append only -- do not overwrite).
4. Update state/ontology.json and state/belief_state.json only if something
   is genuinely axis-worthy. Skip writes if nothing changed.
Next tweet cycle: $NEXT_TWEET.

BROWSEMSG
)
    agent_run --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

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

Do NOT call any read_file tools. Tasks:
1. From the digest above, pick the single most interesting post worth engaging with publicly.
   Criteria: genuine tension with your ontology, strong claim you can sharpen or challenge,
   or a signal moment others have not yet framed correctly.
   Each post line ends with its URL. SKIP any URL in the "already quoted" list above.
2. Navigate to the post URL.
3. Find and click the Quote button (not Reply). A compose modal will open.
4. Click the text area. Type one sentence of sharp commentary -- your actual view.
   No hedging. Max 240 chars (leave room for the quoted tweet).
5. Click the blue Post button. Wait for page update.
   The address bar will show your new permalink (https://x.com/SebastianHunts/status/XXXXXXX).
   If button is greyed out, click the text area and type again.
6. Log to state/posts_log.json with type="quote", tweet_url (your permalink),
   AND source_url (the URL of the tweet you quoted).
7. Done -- do not browse further.

QUOTEMSG
)
    agent_run --agent x-hunter-tweet \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

    # Coherence critique of the quote tweet (only if agent actually posted this cycle)
    node "$PROJECT_ROOT/runner/critique.js" --quote --cycle "$CYCLE" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

  # ── Tweet cycle: synthesize, journal, tweet, push ─────────────────────────
  else
    # Pre-load files — agent skips read tool calls
    _BROWSE_NOTES_FULL=$(cat "$PROJECT_ROOT/state/browse_notes.md" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")
    _MEMORY_RECALL=$(cat "$PROJECT_ROOT/state/memory_recall.txt" 2>/dev/null | sed "s/\`/'/g" || echo "(empty)")

    AGENT_MSG=$(cat <<TWEETMSG
Today is $TODAY $NOW. Tweet cycle $CYCLE -- FILE-ONLY. No browser tool at any point.

All files are pre-loaded below. Do NOT call any read_file tools.

── BROWSE NOTES ─────────────────────────────────────────────────────────
$_BROWSE_NOTES_FULL
── MEMORY RECALL ────────────────────────────────────────────────────────
$_MEMORY_RECALL
─────────────────────────────────────────────────────────────────────────

Tasks (in order, no browser):
1. Synthesize: the single clearest insight, tension, or question from this window.
2. Write journals/${TODAY}_${HOUR}.html
3. Draft tweet: one sentence, honest and direct.
   Add journal URL on new line: https://sebastianhunter.fun/journal/${TODAY}/${HOUR}
   Total <= 280 chars. Self-check (AGENTS.md 13.3) -- write SKIP if not genuine.
4. Write state/tweet_draft.txt (plain text, overwrite).
5. Append to state/posts_log.json (tweet_url="" for now, runner fills it in).
6. Update state/ontology.json and state/belief_state.json.
7. Clear state/browse_notes.md (overwrite with empty string).

TWEETMSG
)
    rm -f "$PROJECT_ROOT/state/tweet_draft.txt" "$PROJECT_ROOT/state/tweet_result.txt"
    agent_run --agent x-hunter-tweet \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

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
            const fs=require('fs'), p='$PROJECT_ROOT/state/posts_log.json';
            const log=JSON.parse(fs.readFileSync(p,'utf-8'));
            const last=log.posts[log.posts.length-1];
            if(last && !last.tweet_url) { last.tweet_url='$TWEET_URL'; last.posted_at=new Date().toISOString(); }
            fs.writeFileSync(p,JSON.stringify(log,null,2));
            console.log('[run] posts_log.json updated with tweet_url');
          " 2>&1 || true
        else
          echo "[run] Tweet posted (URL not captured or post_tweet.js failed)"
        fi
      fi
    else
      echo "[run] No tweet_draft.txt — agent did not produce a draft"
    fi

    # ── Git commit and push ─────────────────────────────────────────────────
    git -C "$PROJECT_ROOT" add journals/ checkpoints/ state/ 2>/dev/null || true
    git -C "$PROJECT_ROOT" commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}" 2>/dev/null || true
    git -C "$PROJECT_ROOT" push origin main 2>/dev/null || true
    echo "[run] git push done"

    # Archive new journals/checkpoints to Irys + local memory index
    node "$PROJECT_ROOT/runner/archive.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

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
