#!/bin/bash
# scraper/stop.sh — stop the collect, reply, and follows loops

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

stop_pid() {
  local label="$1"
  local pid_file="$2"
  if [ ! -f "$pid_file" ]; then
    echo "[$label] not running"
    return
  fi
  local PID
  PID=$(cat "$pid_file")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$pid_file"
    echo "[$label] stopped (pid $PID)"
  else
    rm -f "$pid_file"
    echo "[$label] was not running (stale pid $PID cleaned up)"
  fi
}

stop_pid "scraper" "$SCRIPT_DIR/scraper.pid"
stop_pid "reply"   "$SCRIPT_DIR/reply.pid"
stop_pid "follows" "$SCRIPT_DIR/follows.pid"
