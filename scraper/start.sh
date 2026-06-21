#!/bin/bash
# scraper/start.sh — start the collect, reply, and follows loops
#
# Loops:
#   collect  — runs collect.js every COLLECT_INTERVAL  seconds (default 10 min)
#   reply    — runs reply.js   every REPLY_INTERVAL    seconds (default 30 min)
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

COLLECT_INTERVAL="${COLLECT_INTERVAL:-600}"    # 10 minutes
REPLY_INTERVAL="${REPLY_INTERVAL:-1800}"       # 30 minutes
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
