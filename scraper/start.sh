#!/bin/bash
# scraper/start.sh — start the collect loop as a background process
#
# Runs collect.js every COLLECT_INTERVAL seconds.
# PID is written to scraper/scraper.pid so stop.sh can kill it.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$SCRIPT_DIR/scraper.pid"
LOG_FILE="$SCRIPT_DIR/scraper.log"
COLLECT_INTERVAL="${COLLECT_INTERVAL:-600}"  # 10 minutes default

# Don't start a second copy
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[scraper] already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

collect_loop() {
  echo "[scraper] loop started (interval=${COLLECT_INTERVAL}s)"
  while true; do
    START=$(date +%s)
    echo "[scraper] $(date +%H:%M:%S) — running collect..."
    node "$SCRIPT_DIR/collect.js" >> "$LOG_FILE" 2>&1
    EXIT=$?
    if [ $EXIT -ne 0 ]; then
      echo "[scraper] $(date +%H:%M:%S) — collect exited with code $EXIT (see scraper.log)"
    else
      echo "[scraper] $(date +%H:%M:%S) — collect ok"
    fi
    ELAPSED=$(( $(date +%s) - START ))
    WAIT=$(( COLLECT_INTERVAL - ELAPSED ))
    [ "$WAIT" -gt 0 ] && sleep "$WAIT"
  done
}

collect_loop &
LOOP_PID=$!
echo $LOOP_PID > "$PID_FILE"
echo "[scraper] started (pid $LOOP_PID, interval=${COLLECT_INTERVAL}s)"
