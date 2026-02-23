#!/bin/bash
# runner/run.sh — daily agent session runner
#
# Run once per day for 7 days.
# The agent follows BOOTSTRAP.md autonomously:
#   start stream → launch browser → browse X → update beliefs → write report → git push → stop

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TODAY=$(date +%Y-%m-%d)

# ── Load env ──────────────────────────────────────────────────────────────────
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a && source "$PROJECT_ROOT/.env" && set +a
else
  echo "[run] ERROR: .env not found."
  exit 1
fi

# ── Determine day number ──────────────────────────────────────────────────────
REPORTS=$(ls "$PROJECT_ROOT/daily"/belief_report_*.md 2>/dev/null | wc -l | tr -d ' ')
DAY=$((REPORTS + 1))

if [ "$DAY" -gt 7 ]; then
  echo "[run] 7-day run is complete. Manifesto should be at $PROJECT_ROOT/manifesto.md"
  exit 0
fi

echo "[run] ── Day $DAY / 7 — $TODAY ──────────────────────────────────────"

# ── Confirm gateway is running ────────────────────────────────────────────────
if ! openclaw gateway status &>/dev/null; then
  echo "[run] Gateway not running. Starting..."
  openclaw gateway start
  sleep 2
fi

# ── Start pump.fun stream (if key is configured) ──────────────────────────────
if [ -n "$PUMPFUN_STREAM_KEY" ]; then
  echo "[run] Starting pump.fun stream..."
  bash "$PROJECT_ROOT/stream/start.sh"
else
  echo "[run] PUMPFUN_STREAM_KEY not set — skipping stream"
fi

# ── Configure git identity for auto-commit ────────────────────────────────────
git -C "$PROJECT_ROOT" config user.name "${GIT_USER_NAME:-x-hunter-agent}"
git -C "$PROJECT_ROOT" config user.email "${GIT_USER_EMAIL:-agent@x-hunter.local}"

if [ -n "$GITHUB_TOKEN" ]; then
  REPO_URL="https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
  git -C "$PROJECT_ROOT" remote set-url origin "$REPO_URL" 2>/dev/null || true
fi

# ── Send session message to OpenClaw agent ────────────────────────────────────
echo "[run] Starting agent session (Day $DAY)..."

openclaw agent \
  --message "$(cat <<EOF
Today is $TODAY. This is Day $DAY of 7.

Follow BOOTSTRAP.md exactly.

Key context:
- Day number: $DAY
- If Day <= 2: observe only, no belief updates
- Write daily report to: daily/belief_report_$TODAY.md
- After writing the report, run the git commit and push as described in TOOLS.md
- Stop the browser and stream when done

Begin now.
EOF
)" \
  --thinking high \
  --verbose on \
  --workspace "$PROJECT_ROOT"

# ── Stop stream ───────────────────────────────────────────────────────────────
echo "[run] Stopping stream..."
bash "$PROJECT_ROOT/stream/stop.sh"

echo "[run] Day $DAY session complete."
echo "[run] Report: $PROJECT_ROOT/daily/belief_report_$TODAY.md"
