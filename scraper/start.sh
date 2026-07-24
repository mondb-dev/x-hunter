#!/bin/bash
# scraper/start.sh — start the collect, reply, and follows loops
#
# Loops:
#   mentions — runs mentions.js every MENTIONS_INTERVAL seconds (default 2 min;
#              set MENTIONS_INTERVAL=0 to disable — collect.js still captures)
#   collect  — runs collect.js every COLLECT_INTERVAL  seconds (default 5 min)
#   reply    — runs reply.js   every REPLY_INTERVAL    seconds (default 10 min)
#   follows  — runs follows.js every FOLLOWS_INTERVAL  seconds (default 3 hrs)
#
# Each loop has its own PID file so stop.sh can kill them independently.
# All output is appended to scraper/scraper.log.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$SCRIPT_DIR/scraper.log"

COLLECT_PID_FILE="$SCRIPT_DIR/scraper.pid"
REPLY_PID_FILE="$SCRIPT_DIR/reply.pid"
FOLLOWS_PID_FILE="$SCRIPT_DIR/follows.pid"
MENTIONS_PID_FILE="$SCRIPT_DIR/mentions.pid"

MENTIONS_INTERVAL="${MENTIONS_INTERVAL:-120}"  # 2 minutes  — fast mention poll (0 disables; collect.js still captures)
COLLECT_INTERVAL="${COLLECT_INTERVAL:-300}"    # 5 minutes  — capture-side freshness floor + fallback capture
REPLY_INTERVAL="${REPLY_INTERVAL:-600}"        # 10 minutes — drain cadence (posting still throttled by MIN_GAP/MAX_PER_RUN/MAX_PER_DAY in reply.js)
FOLLOWS_INTERVAL="${FOLLOWS_INTERVAL:-10800}"  # 3 hours

# ── Collect loop ──────────────────────────────────────────────────────────────
if [ -f "$COLLECT_PID_FILE" ] && kill -0 "$(cat "$COLLECT_PID_FILE")" 2>/dev/null; then
  echo "[scraper] collect loop already running (pid $(cat "$COLLECT_PID_FILE"))"
else
  collect_loop() {
    echo "[scraper] collect loop started (interval=${COLLECT_INTERVAL}s)" >> "$LOG_FILE" 2>&1
    while true; do
      START=$(date +%s)
      echo "[scraper] $(date +%H:%M:%S) — running collect..." >> "$LOG_FILE" 2>&1
      node "$SCRIPT_DIR/collect.js" >> "$LOG_FILE" 2>&1
      EXIT=$?
      if [ $EXIT -ne 0 ]; then
        echo "[scraper] $(date +%H:%M:%S) — collect exited $EXIT" >> "$LOG_FILE" 2>&1
      else
        echo "[scraper] $(date +%H:%M:%S) — collect ok" >> "$LOG_FILE" 2>&1
      fi
      ELAPSED=$(( $(date +%s) - START ))
      WAIT=$(( COLLECT_INTERVAL - ELAPSED ))
      [ "$WAIT" -gt 0 ] && sleep "$WAIT"
    done
  }

  collect_loop &
  CPID=$!
  echo $CPID > "$COLLECT_PID_FILE"
  echo "[scraper] collect loop started (pid $CPID, interval=${COLLECT_INTERVAL}s)"
fi

# ── Reply loop ────────────────────────────────────────────────────────────────
if [ -f "$REPLY_PID_FILE" ] && kill -0 "$(cat "$REPLY_PID_FILE")" 2>/dev/null; then
  echo "[scraper] reply loop already running (pid $(cat "$REPLY_PID_FILE"))"
else
  reply_loop() {
    # Wait one collect cycle so the queue can populate first
    sleep "$COLLECT_INTERVAL"
    echo "[reply] reply loop started (interval=${REPLY_INTERVAL}s)" >> "$LOG_FILE" 2>&1
    while true; do
      START=$(date +%s)
      echo "[reply] $(date +%H:%M:%S) — running reply processor..." >> "$LOG_FILE" 2>&1
      node "$SCRIPT_DIR/reply.js" >> "$LOG_FILE" 2>&1
      EXIT=$?
      if [ $EXIT -ne 0 ]; then
        echo "[reply] $(date +%H:%M:%S) — reply exited $EXIT" >> "$LOG_FILE" 2>&1
      else
        echo "[reply] $(date +%H:%M:%S) — reply ok" >> "$LOG_FILE" 2>&1
      fi
      ELAPSED=$(( $(date +%s) - START ))
      WAIT=$(( REPLY_INTERVAL - ELAPSED ))
      [ "$WAIT" -gt 0 ] && sleep "$WAIT"
    done
  }

  reply_loop &
  RPID=$!
  echo $RPID > "$REPLY_PID_FILE"
  echo "[scraper] reply loop started (pid $RPID, interval=${REPLY_INTERVAL}s)"
fi

# ── Mentions fast-poll loop ─────────────────────────────────────────────────────
if [ "$MENTIONS_INTERVAL" -eq 0 ] 2>/dev/null; then
  echo "[scraper] mentions fast-poll disabled (MENTIONS_INTERVAL=0)"
elif [ -f "$MENTIONS_PID_FILE" ] && kill -0 "$(cat "$MENTIONS_PID_FILE")" 2>/dev/null; then
  echo "[scraper] mentions loop already running (pid $(cat "$MENTIONS_PID_FILE"))"
else
  mentions_loop() {
    echo "[mentions] mentions loop started (interval=${MENTIONS_INTERVAL}s)" >> "$LOG_FILE" 2>&1
    while true; do
      START=$(date +%s)
      node "$SCRIPT_DIR/mentions.js" >> "$LOG_FILE" 2>&1
      ELAPSED=$(( $(date +%s) - START ))
      WAIT=$(( MENTIONS_INTERVAL - ELAPSED ))
      [ "$WAIT" -gt 0 ] && sleep "$WAIT"
    done
  }

  mentions_loop &
  MPID=$!
  echo $MPID > "$MENTIONS_PID_FILE"
  echo "[scraper] mentions loop started (pid $MPID, interval=${MENTIONS_INTERVAL}s)"
fi

# ── Follows loop ──────────────────────────────────────────────────────────────
if [ -f "$FOLLOWS_PID_FILE" ] && kill -0 "$(cat "$FOLLOWS_PID_FILE")" 2>/dev/null; then
  echo "[scraper] follows loop already running (pid $(cat "$FOLLOWS_PID_FILE"))"
else
  follows_loop() {
    # Wait one collect cycle so the accounts table has data before first run
    sleep "$COLLECT_INTERVAL"
    echo "[follows] follows loop started (interval=${FOLLOWS_INTERVAL}s)" >> "$LOG_FILE" 2>&1
    while true; do
      START=$(date +%s)
      echo "[follows] $(date +%H:%M:%S) — running follows processor..." >> "$LOG_FILE" 2>&1
      node "$SCRIPT_DIR/follows.js" >> "$LOG_FILE" 2>&1
      EXIT=$?
      if [ $EXIT -ne 0 ]; then
        echo "[follows] $(date +%H:%M:%S) — follows exited $EXIT" >> "$LOG_FILE" 2>&1
      else
        echo "[follows] $(date +%H:%M:%S) — follows ok" >> "$LOG_FILE" 2>&1
      fi
      ELAPSED=$(( $(date +%s) - START ))
      WAIT=$(( FOLLOWS_INTERVAL - ELAPSED ))
      [ "$WAIT" -gt 0 ] && sleep "$WAIT"
    done
  }

  follows_loop &
  FPID=$!
  echo $FPID > "$FOLLOWS_PID_FILE"
  echo "[scraper] follows loop started (pid $FPID, interval=${FOLLOWS_INTERVAL}s)"
fi
