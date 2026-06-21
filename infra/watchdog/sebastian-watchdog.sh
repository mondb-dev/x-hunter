#!/bin/bash
# Hang-guard: restart sebastian-runner if orchestrator.log goes stale
# (process alive but not cycling — the 8h-hang failure mode of 2026-06-21).
set -uo pipefail
LOG=/home/raymond_d_baldonado_gmail_com/hunter/runner/orchestrator.log
THRESHOLD=7200   # 120 min; safely above max cycle (~17m) + max inter-cycle wait (60m)
now=$(date +%s)
mtime=$(stat -c %Y "$LOG" 2>/dev/null || echo 0)
age=$(( now - mtime ))
if [ "$age" -gt "$THRESHOLD" ]; then
  logger -t sebastian-watchdog "STALE: orchestrator.log age ${age}s (>${THRESHOLD}s) — restarting sebastian-runner"
  systemctl restart sebastian-runner
else
  logger -t sebastian-watchdog "ok: orchestrator.log age ${age}s"
fi
