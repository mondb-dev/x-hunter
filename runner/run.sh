#!/bin/bash
# runner/run.sh — continuous agent loop
#
# Two-tier cycle:
#   Browse cycle  (every 10 min): read X, take raw notes, update ontology
#   Tweet cycle   (every 3rd = 30 min): synthesize notes, journal, tweet, git push
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

# ── Two-tier cycle loop ────────────────────────────────────────────────────────
# Browse cycle: every 20 minutes
# Tweet cycle:  every 3rd browse cycle (= every 60 minutes)
CYCLE=0
BROWSE_INTERVAL=1200  # 20 minutes in seconds
TWEET_EVERY=6         # tweet on cycles 6, 12, 18, ... (every 2 hours)

trap 'echo "[run] Stopping..."; bash "$PROJECT_ROOT/stream/stop.sh" 2>/dev/null; exit 0' INT TERM

while true; do
  CYCLE=$((CYCLE + 1))
  TODAY=$(date +%Y-%m-%d)
  NOW=$(date +%H:%M)
  HOUR=$(date +%H)
  CYCLE_START=$(date +%s)

  # Determine cycle type
  if [ $(( CYCLE % TWEET_EVERY )) -eq 0 ]; then
    CYCLE_TYPE="TWEET"
  else
    CYCLE_TYPE="BROWSE"
  fi

  # Detect first-ever run by absence of journal files (more reliable than posts_log)
  JOURNAL_COUNT=$(ls "$PROJECT_ROOT/journals/"*.html 2>/dev/null | wc -l | tr -d ' ')

  echo "[run] ── Cycle $CYCLE ($CYCLE_TYPE) — $TODAY $NOW (journals=$JOURNAL_COUNT) ──"

  # ── Ensure browser is alive before each cycle (prevents CDP timeout) ──────
  openclaw browser --browser-profile x-hunter start 2>/dev/null || true
  sleep 1

  # ── First-ever cycle: intro tweet + profile setup ─────────────────────────
  if [ "$JOURNAL_COUNT" -eq 0 ]; then
    openclaw agent --agent x-hunter \
      --message "$(cat <<EOF
Today is $TODAY $NOW. This is the very first run — total_posts is 0.

Follow BOOTSTRAP.md §6 (profile setup) and §6b (seed tweet) and §6c (intro tweet) first.

After the intro tweet, do a first browse pass:
1. Read state/browse_notes.md (empty on first run).
2. Navigate to https://x.com — scroll the feed, read at least 15 posts end to end.
3. Click into at least 3 threads that catch your attention and read the replies.
4. Navigate to https://x.com/search?q=... on 2 topics that interested you and read 10 more posts each.
5. Append everything notable to state/browse_notes.md (quotes, tensions, source URLs).
6. Update state/ontology.json if anything is axis-worthy.
7. Done — do not tweet again this cycle.

EOF
)" \
      --thinking high \
      --verbose on

  # ── Browse cycle: read, note, update ontology ─────────────────────────────
  elif [ "$CYCLE_TYPE" = "BROWSE" ]; then
    openclaw agent --agent x-hunter \
      --message "$(cat <<EOF
Today is $TODAY $NOW. This is browse cycle $CYCLE — no tweet this cycle.

Your task — read as much as you can, go deep:
1. Read state/browse_notes.md to recall what you've noted so far this window.
2. Navigate to https://x.com — scroll the main feed, read at least 20 posts end to end.
3. Click into at least 4 threads that interest or provoke you and read the full reply chains.
4. Pick 2–3 topics, tensions, or accounts from what you just read and search/navigate deeper:
   - https://x.com/search?q=<topic> — read 15+ posts per search
   - Or navigate directly to accounts and read their recent posts + replies
5. Append everything notable to state/browse_notes.md:
   - Exact quotes or paraphrases
   - Tensions between accounts or positions
   - Patterns you're starting to notice
   - Source URLs (tweet links)
6. Consider follows (AGENTS.md §16): if any account genuinely impressed you across multiple posts, follow them — max 3 this cycle. Log each to state/trust_graph.json with reason, cluster, and timestamp.
7. Update state/ontology.json and state/belief_state.json if anything is axis-worthy.
8. Done — do not tweet. Next tweet cycle: cycle $(( (CYCLE / TWEET_EVERY + 1) * TWEET_EVERY )).

EOF
)" \
      --thinking low \
      --verbose on

  # ── Tweet cycle: synthesize, journal, tweet, push ─────────────────────────
  else
    openclaw agent --agent x-hunter \
      --message "$(cat <<EOF
Today is $TODAY $NOW. This is tweet cycle $CYCLE — synthesize, journal, tweet, push.

Your task:
1. Read state/browse_notes.md — everything noted in the last browse cycles.
2. Do one final browse pass to add context: scroll feed (15+ posts), click into 2 threads, run 1–2 searches on topics from your notes.
3. Synthesize: what is the single clearest insight, tension, or question from this window?
4. Write the journal entry: journals/${TODAY}_${HOUR}.html
5. Draft the tweet: the geist of the synthesis in one honest sentence or question.
   Add the journal URL on a new line: https://sebastianhunter.fun/journal/${TODAY}/${HOUR}
   Total ≤ 280 characters.
6. Self-check (AGENTS.md §13.3). If not genuine — skip the tweet, still do the rest.
7. Post via https://x.com/compose/post
8. Log to state/posts_log.json (include journal_url field).
9. Update state/ontology.json and state/belief_state.json.
10. Clear state/browse_notes.md (overwrite with empty string — start fresh next window).
11. Git commit and push:
    git add journals/ state/ && git commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}" && git push origin main
12. Done — do not start another cycle.

EOF
)" \
      --thinking high \
      --verbose on
  fi

  # ── Wait out the remainder of the 10-minute window ─────────────────────────
  ELAPSED=$(( $(date +%s) - CYCLE_START ))
  WAIT=$(( BROWSE_INTERVAL - ELAPSED ))
  if [ "$WAIT" -gt 0 ]; then
    echo "[run] Cycle $CYCLE ($CYCLE_TYPE) done in ${ELAPSED}s. Next cycle in ${WAIT}s..."
    sleep "$WAIT"
  else
    echo "[run] Cycle $CYCLE ($CYCLE_TYPE) done in ${ELAPSED}s. Starting next cycle immediately."
  fi
done
