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
    openclaw agent --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking high \
      --verbose on

  # ── Browse cycle: read digest + topic summary, take notes ───────────────
  elif [ "$CYCLE_TYPE" = "BROWSE" ]; then
    # Generate topic summary + memory recall from SQLite index before invoking AI
    node "$PROJECT_ROOT/scraper/query.js" --hours 4 > /dev/null 2>&1 || true
    node "$PROJECT_ROOT/runner/recall.js" --limit 5 >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true

    NEXT_TWEET=$(( (CYCLE / TWEET_EVERY + 1) * TWEET_EVERY ))
    AGENT_MSG=$(cat <<BROWSEMSG
Today is $TODAY $NOW. This is browse cycle $CYCLE -- no tweet this cycle.

A background scraper has been collecting and scoring posts from X every 10 minutes.
It extracts keyphrases via RAKE and indexes everything in a SQLite FTS5 database.

Read these two files to understand the current information landscape:
  state/topic_summary.txt  -- topic clusters + top keywords from last 4 hours
  state/feed_digest.txt    -- clustered scored digest (newest block at bottom)

Digest format (clusters):
  CLUSTER N . "label" . M posts [. TRENDING]
    @user [vSCORE TTRUST NNOVELTY] "text" [engagement]  {keywords}
    > @reply: "reply text" [engagement]
  SINGLETONS . M posts  (posts that did not cluster with anything)

  v = velocity (HN-gravity, higher = trending now)
  T = trust score 0-10 from your trust_graph (0 = unknown)
  N = TF-IDF novelty (0-5): 5.0 = rarest topic this window; 0 = commonly recurring
  TRENDING = keyword frequency more than doubled vs. previous 4-hour window
  <- novel = singleton post with novelty >= 4.0 (pay close attention)

The scraper also:
- Removes near-duplicate posts (same story from different accounts)
- Groups related posts by keyword overlap into clusters
- Tracks account quality over time (accounts table) for follow analysis

Your task:
1. Read state/browse_notes.md -- recall what you have noted so far this window.
2. Read state/topic_summary.txt -- what topics are clustering right now?
3. Read state/feed_digest.txt -- navigate by cluster, not linearly.
   Start with TRENDING clusters and high-N (novel) posts.
4. Identify the 3-5 most interesting tensions, emerging ideas, or signal moments.
   Focus on: TRENDING clusters, <- novel singletons, trusted accounts (T >= 5),
   or voices saying something that resonates with or challenges your ontology axes.
5. For anything you want to explore deeper, navigate directly via browser:
   https://x.com/<username>  or  https://x.com/search?q=<topic>
6. Append everything notable to state/browse_notes.md:
   - Exact quotes or paraphrases with source @username
   - Tensions between accounts or positions
   - Patterns emerging across multiple posts
   - Note any clusters that seem to be emerging conversations worth watching
7. The scraper auto-follows accounts algorithmically (follows.js, every 3 hours).
   You may still follow manually if an account genuinely impresses you beyond
   the algorithm reach. Max 3 manual follows this cycle if so.
   Log to state/trust_graph.json with reason + cluster.
8. Update state/ontology.json and state/belief_state.json if anything is axis-worthy.
   These feed back into the scraper scoring -- update them carefully.
9. Done -- do not tweet. Next tweet cycle: cycle $NEXT_TWEET.

BROWSEMSG
)
    openclaw agent --agent x-hunter \
      --message "$AGENT_MSG" \
      --thinking low \
      --verbose on

  # ── Tweet cycle: synthesize, journal, tweet, push ─────────────────────────
  else
    AGENT_MSG=$(cat <<TWEETMSG
Today is $TODAY $NOW. This is tweet cycle $CYCLE -- synthesize, journal, tweet, push.

Your task:
1. Read state/browse_notes.md -- everything noted in the last browse cycles.
2. Read state/feed_digest.txt -- the latest scored digest for any final context.
3. Read state/memory_recall.txt -- your relevant past thinking on current topics.
   Use it to ask: have I thought about this before? Has my view evolved? Am I repeating myself?
4. Synthesize: what is the single clearest insight, tension, or question from this window?
5. Write the journal entry: journals/${TODAY}_${HOUR}.html
6. Draft the tweet: the geist of the synthesis in one honest sentence or question.
   Add the journal URL on a new line: https://sebastianhunter.fun/journal/${TODAY}/${HOUR}
   Total <= 280 characters.
7. Self-check (AGENTS.md section 13.3). If not genuine -- skip the tweet, still do the rest.
8. Post via https://x.com/compose/post
9. Log to state/posts_log.json (include journal_url field).
10. Update state/ontology.json and state/belief_state.json.
11. Clear state/browse_notes.md (overwrite with empty string -- start fresh next window).
12. Clear state/feed_digest.txt (overwrite with empty string -- scraper will refill it).
13. Git commit and push:
    git add journals/ checkpoints/ state/ && git commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}" && git push origin main
14. Done -- do not start another cycle.

TWEETMSG
)
    openclaw agent --agent x-hunter-tweet \
      --message "$AGENT_MSG" \
      --thinking high \
      --verbose on

    # Archive new journals/checkpoints to Irys + local memory index
    node "$PROJECT_ROOT/runner/archive.js" >> "$PROJECT_ROOT/runner/runner.log" 2>&1 || true
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
