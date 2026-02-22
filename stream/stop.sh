#!/bin/bash
# stream/stop.sh — stop pump.fun live stream

PIDFILE="$(dirname "$0")/stream.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "[stream] not running"
  exit 0
fi

PID=$(cat "$PIDFILE")

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "[stream] stopped (pid $PID)"
else
  echo "[stream] process $PID not found (already stopped)"
fi

rm -f "$PIDFILE"
