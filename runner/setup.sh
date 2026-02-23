#!/bin/bash
# runner/setup.sh — one-time setup
# Run this once before the first session.
#
# What it does:
#   1. Installs OpenClaw (if not present)
#   2. Points OpenClaw workspace to this project root
#   3. Registers the x-hunter agent
#   4. Installs and starts the OpenClaw gateway daemon
#   5. Sets up the x-hunter Chrome browser profile

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load env ──────────────────────────────────────────────────────────────────
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a && source "$PROJECT_ROOT/.env" && set +a
else
  echo "[setup] ERROR: .env not found. Copy .env.example to .env and fill it in."
  exit 1
fi

# ── Install OpenClaw if needed ────────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
  echo "[setup] Installing openclaw..."
  npm install -g openclaw@latest
fi

echo "[setup] openclaw version: $(openclaw --version)"

# ── Configure workspace → this project root ───────────────────────────────────
echo "[setup] Setting workspace to $PROJECT_ROOT"
openclaw config set agents.defaults.workspace "$PROJECT_ROOT"

# ── Configure LLM model ───────────────────────────────────────────────────────
echo "[setup] Setting model to google/gemini-2.5-flash..."
openclaw config set agents.defaults.model.primary "google/gemini-2.5-flash"
if [ -n "$GOOGLE_API_KEY" ]; then
  # Try config store; OpenClaw also reads GOOGLE_API_KEY from env automatically
  openclaw config set providers.google.apiKey "$GOOGLE_API_KEY" 2>/dev/null || true
else
  echo "[setup] WARNING: GOOGLE_API_KEY not set in .env — agent will not be able to call the model"
fi

# ── Generate Solana wallet if not already configured ─────────────────────────
if [ -z "$SOLANA_PUBLIC_KEY" ]; then
  echo "[setup] No SOLANA_PUBLIC_KEY found — generating wallet..."
  node "$PROJECT_ROOT/scripts/gen-wallet.js" | tee /tmp/wallet-output.txt
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "  ACTION REQUIRED"
  echo "  Copy the two SOLANA_ lines above into your .env file."
  echo "  Then re-run: bash runner/setup.sh"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  echo "[setup] Solana wallet configured: $SOLANA_PUBLIC_KEY"
fi

# ── Register the x-hunter agent ───────────────────────────────────────────────
echo "[setup] Registering x-hunter agent..."
openclaw agents add x-hunter \
  --workspace "$PROJECT_ROOT" \
  --non-interactive || echo "[setup] Agent may already exist, continuing..."

# ── Install gateway daemon ────────────────────────────────────────────────────
echo "[setup] Installing OpenClaw gateway daemon..."
openclaw onboard --install-daemon --non-interactive

# ── Start gateway ─────────────────────────────────────────────────────────────
echo "[setup] Starting gateway..."
openclaw gateway start

sleep 2
openclaw gateway status

# ── Set up x-hunter Chrome browser profile ────────────────────────────────────
echo "[setup] Creating x-hunter browser profile..."
openclaw browser create-profile --name x-hunter 2>/dev/null || echo "[setup] Profile may already exist, continuing..."

echo "[setup] Starting x-hunter browser..."
openclaw browser --browser-profile x-hunter start
sleep 3

echo "[setup] Opening X login page..."
openclaw browser --browser-profile x-hunter open https://x.com/login

echo ""
echo "════════════════════════════════════════════════════════"
echo "  ACTION REQUIRED"
echo "  Log in to X in the browser window that just opened."
echo "  Use the account you want the agent to observe from."
echo "  Once logged in, press ENTER here to continue."
echo "════════════════════════════════════════════════════════"
read -r

openclaw browser --browser-profile x-hunter snapshot
openclaw browser --browser-profile x-hunter stop

echo ""
echo "[setup] Done. Run ./runner/run.sh to start the agent."
