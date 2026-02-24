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

# ── Two-tier agent cycle loop ─────────────────────────────────────────────────
# Browse cycle: every 20 minutes (AI reads pre-scraped digest)
# Tweet cycle:  every 6th browse cycle (every 2 hours)
CYCLE=0
BROWSE_INTERVAL=1200  # 20 minutes in seconds
TWEET_EVERY=6         # tweet on cycles 6, 12, 18, ... (every 2 hours)

trap 'echo "[run] Stopping..."; bash "$PROJECT_ROOT/scraper/stop.sh" 2>/dev/null; bash "$PROJECT_ROOT/stream/stop.sh" 2>/dev/null; exit 0' INT TERM

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

  # Detect first-ever run by absence of journal files
  JOURNAL_COUNT=$(ls "$PROJECT_ROOT/journals/"*.html 2>/dev/null | wc -l | tr -d ' ')

  # Check if scraper has produced any digest yet
  DIGEST_SIZE=$(wc -c < "$PROJECT_ROOT/state/feed_digest.txt" 2>/dev/null || echo 0)

  echo "[run] ── Cycle $CYCLE ($CYCLE_TYPE) — $TODAY $NOW (journals=$JOURNAL_COUNT, digest=${DIGEST_SIZE}b) ──"

  # ── Ensure browser is alive before each cycle ────────────────────────────
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

  # ── Browse cycle: read digest + topic summary, take notes ───────────────
  elif [ "$CYCLE_TYPE" = "BROWSE" ]; then
    # Generate topic summary from SQLite index before invoking AI
    node "$PROJECT_ROOT/scraper/query.js" --hours 4 > /dev/null 2>&1 || true

    openclaw agent --agent x-hunter \
      --message "$(cat <<EOF
Today is $TODAY $NOW. This is browse cycle $CYCLE — no tweet this cycle.

A background scraper has been collecting and scoring posts from X every 10 minutes.
It extracts keyphrases via RAKE and indexes everything in a SQLite FTS5 database.

Read these two files to understand the current information landscape:
  state/topic_summary.txt  — topic clusters + top keywords from last 4 hours
  state/feed_digest.txt    — full scored post digest (newest at bottom)

Digest format: @user [vSCORE TTRUST] "text" [engagement]  {keywords}
  vSCORE  = velocity (HN-gravity, higher = trending now)
  TTRUST  = trust score 0-10 from your trust_graph (0 = unknown)
  {}      = RAKE keyphrases extracted from post text
  indented > lines = top 5 replies scored by engagement

Your task:
1. Read state/browse_notes.md — recall what you've noted so far this window.
2. Read state/topic_summary.txt — what topics are clustering right now?
3. Read state/feed_digest.txt — scan for posts that connect to those clusters.
4. Identify the 3-5 most interesting posts, tensions, or emerging ideas.
   Focus on: high-velocity from trusted accounts, or unexpected voices saying
   something that resonates with your ontology axes.
5. For anything you want to explore deeper, navigate directly via browser:
   https://x.com/<username>  or  https://x.com/search?q=<topic>
6. Append everything notable to state/browse_notes.md:
   - Exact quotes or paraphrases with source @username
   - Tensions between accounts or positions
   - Patterns emerging across multiple posts
7. Consider follows (AGENTS.md §16): if an account genuinely impressed you,
   follow them — max 3 this cycle. Log to state/trust_graph.json with reason + cluster.
8. Update state/ontology.json and state/belief_state.json if anything is axis-worthy.
   These feed back into the scraper's scoring — update them carefully.
9. Done — do not tweet. Next tweet cycle: cycle $(( (CYCLE / TWEET_EVERY + 1) * TWEET_EVERY )).

EOF
)" \
      --thinking low \
      --verbose on

  # ── Tweet cycle: synthesize, journal, tweet, push ─────────────────────────
  else
    openclaw agent --agent x-hunter-tweet \
      --message "$(cat <<EOF
Today is $TODAY $NOW. This is tweet cycle $CYCLE — synthesize, journal, tweet, push.

Your task:
1. Read state/browse_notes.md — everything noted in the last browse cycles.
2. Read state/feed_digest.txt — the latest scored digest for any final context.
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
11. Clear state/feed_digest.txt (overwrite with empty string — scraper will refill it).
12. Git commit and push:
    git add journals/ state/ && git commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}" && git push origin main
13. Done — do not start another cycle.

EOF
)" \
      --thinking high \
      --verbose on
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
