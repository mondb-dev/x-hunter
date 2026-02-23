#!/bin/bash
# runner/run.sh — daily agent session runner
#
# Run once per day, indefinitely.
# Every 7 days the agent generates a checkpoint in addition to the daily report.
# The agent follows BOOTSTRAP.md autonomously:
#   start stream → launch browser → browse X → update beliefs → write report
#   → (checkpoint if day%7==0) → git push → stop

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

# ── Is this a checkpoint day? ─────────────────────────────────────────────────
CHECKPOINT_DAY=false
CHECKPOINT_N=0
if [ $((DAY % 3)) -eq 0 ]; then
  CHECKPOINT_DAY=true
  CHECKPOINT_N=$((DAY / 3))
fi

if [ "$CHECKPOINT_DAY" = true ]; then
  echo "[run] ── Day $DAY — CHECKPOINT $CHECKPOINT_N — $TODAY ──────────────"
else
  echo "[run] ── Day $DAY — $TODAY ──────────────────────────────────────────"
fi

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

# ── Build checkpoint instruction ─────────────────────────────────────────────
if [ "$CHECKPOINT_DAY" = true ]; then
  CHECKPOINT_INSTRUCTION="
CHECKPOINT DAY: This is checkpoint $CHECKPOINT_N (day $DAY).
After writing the daily report, also generate:
  checkpoints/checkpoint_$CHECKPOINT_N.md
  checkpoints/latest.md (same content)
Per AGENTS.md section 9. Include both files in the git commit."
else
  CHECKPOINT_INSTRUCTION=""
fi

# ── Send session message to OpenClaw agent ────────────────────────────────────
echo "[run] Starting agent session (Day $DAY)..."

# Determine observation phase within the current 3-day cycle
DAY_IN_CYCLE=$(( (DAY - 1) % 3 + 1 ))

openclaw agent \
  --message "$(cat <<EOF
Today is $TODAY. This is Day $DAY (day $DAY_IN_CYCLE of the current 3-day cycle).

Follow BOOTSTRAP.md exactly.

Key context:
- Total day number: $DAY
- Day in current cycle: $DAY_IN_CYCLE
- If day_in_cycle <= 2: observe only, no belief updates
- Write daily report to: daily/belief_report_$TODAY.md
- After writing the report, commit and push as described in TOOLS.md
- Stop the browser and stream when done
$CHECKPOINT_INSTRUCTION

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
if [ "$CHECKPOINT_DAY" = true ]; then
  echo "[run] Checkpoint: $PROJECT_ROOT/checkpoints/checkpoint_$CHECKPOINT_N.md"
fi
