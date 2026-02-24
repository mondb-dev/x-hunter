#!/bin/bash
# scraper/stop.sh — stop the collect loop

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/scraper.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "[scraper] not running"
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  rm -f "$PID_FILE"
  echo "[scraper] stopped (pid $PID)"
else
  rm -f "$PID_FILE"
  echo "[scraper] was not running (stale pid $PID cleaned up)"
fi
