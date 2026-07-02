#!/bin/bash
# run_tgbot.sh — launchd wrapper for the Telegram bot on macOS.
# launchd (unlike systemd) has no EnvironmentFile, and telegram_bot.js's config.js
# does not self-load dotenv, so we source .env here before exec'ing node.
set -euo pipefail
PROJECT_ROOT="/Users/mondb/Documents/Projects/hunter"
cd "$PROJECT_ROOT"
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a && source "$PROJECT_ROOT/.env" && set +a
else
  echo "[run_tgbot] ERROR: .env not found at $PROJECT_ROOT/.env" >&2
  exit 1
fi
exec /usr/local/bin/node "$PROJECT_ROOT/runner/telegram_bot.js"
