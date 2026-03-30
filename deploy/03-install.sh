#!/bin/bash
# deploy/03-install.sh — Server-side install (runs ON the GCP VM)
#
# Sets up: Node.js 24, Chrome headless, OpenClaw, npm deps, systemd services
#
# Usage (on VM):
#   cd ~/hunter && bash deploy/03-install.sh

set -euo pipefail

PROJECT_DIR="$HOME/hunter"
OPENCLAW_PROFILE="x-hunter"

echo "═══════════════════════════════════════════════════"
echo "  Sebastian D. Hunter — Server Install"
echo "═══════════════════════════════════════════════════"

# ── Step 1: System packages ───────────────────────────────────────────────────
echo "[1/8] Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  curl wget git jq unzip \
  ca-certificates gnupg \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
  libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxss1 libasound2 libpangocairo-1.0-0 \
  libx11-xcb1 libxcb1 fonts-liberation xdg-utils \
  2>/dev/null

# ── Step 2: Node.js 24 via NodeSource ────────────────────────────────────────
echo "[2/8] Installing Node.js 24..."
if command -v node &>/dev/null && [[ "$(node --version)" == v24* ]]; then
  echo "  → Node.js $(node --version) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - 2>/dev/null
  sudo apt-get install -y -qq nodejs
  echo "  → Node.js $(node --version) installed"
fi

# ── Step 3: Google Chrome (headless shell) ────────────────────────────────────
echo "[3/8] Installing Google Chrome..."
if command -v google-chrome-stable &>/dev/null; then
  echo "  → Chrome already installed"
else
  wget -q -O /tmp/chrome.deb \
    "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  sudo dpkg -i /tmp/chrome.deb 2>/dev/null || sudo apt-get install -f -y -qq
  rm -f /tmp/chrome.deb
  echo "  → Chrome $(google-chrome-stable --version) installed"
fi

# ── Step 4: OpenClaw ──────────────────────────────────────────────────────────
echo "[4/8] Installing OpenClaw..."
if command -v openclaw &>/dev/null; then
  echo "  → openclaw $(openclaw --version) already installed"
else
  sudo npm install -g openclaw@latest
  echo "  → openclaw $(openclaw --version) installed"
fi

# ── Step 5: npm install (scraper + runner) ────────────────────────────────────
echo "[5/8] Installing npm dependencies..."
cd "$PROJECT_DIR/scraper" && npm install --production 2>/dev/null
cd "$PROJECT_DIR/runner"  && npm install --production 2>/dev/null
cd "$PROJECT_DIR"

# ── Step 6: Configure OpenClaw ────────────────────────────────────────────────
echo "[6/8] Configuring OpenClaw..."

# Load env for API keys
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a && source "$PROJECT_DIR/.env" && set +a
fi

# Set workspace and model
openclaw config set agents.defaults.workspace "$PROJECT_DIR"
openclaw config set agents.defaults.model.primary "google/gemini-2.5-flash"

# Register x-hunter agent
openclaw agents add x-hunter \
  --workspace "$PROJECT_DIR" \
  --non-interactive 2>/dev/null || echo "  → Agent x-hunter may already exist"

# Register x-hunter-tweet agent
openclaw agents add x-hunter-tweet \
  --workspace "$PROJECT_DIR" \
  --non-interactive 2>/dev/null || echo "  → Agent x-hunter-tweet may already exist"

# Set API key if available
if [ -n "${GOOGLE_API_KEY:-}" ]; then
  openclaw config set providers.google.apiKey "$GOOGLE_API_KEY" 2>/dev/null || true
fi

# Install gateway daemon (creates systemd service on Linux)
openclaw onboard --install-daemon --non-interactive 2>/dev/null || true

# ── Step 7: Create browser profile ───────────────────────────────────────────
echo "[7/8] Setting up browser profile..."

# If browser profile was migrated (02-migrate-data.sh), it already exists.
# Otherwise create a fresh one.
if [ ! -d "$HOME/.openclaw/browser/$OPENCLAW_PROFILE/user-data" ]; then
  openclaw browser create-profile --name "$OPENCLAW_PROFILE" 2>/dev/null || true
  echo "  → Created fresh browser profile (you'll need to log in to X)"
else
  echo "  → Browser profile exists (migrated from local machine)"
fi

# ── Step 8: Systemd services ─────────────────────────────────────────────────
echo "[8/8] Installing systemd services..."
SYSTEMCTL_BIN="$(command -v systemctl)"

# --- Gateway service ---
# OpenClaw's --install-daemon may have already created one.
# We install our own to ensure correct profile + env.
sudo tee /etc/systemd/system/openclaw-gateway.service > /dev/null << EOF
[Unit]
Description=OpenClaw Gateway (x-hunter)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=300

[Service]
Type=simple
User=$USER
Environment=HOME=$HOME
Environment=OPENCLAW_PROFILE=$OPENCLAW_PROFILE
Environment=OPENCLAW_STATE_DIR=$HOME/.openclaw-$OPENCLAW_PROFILE
Environment=OPENCLAW_CONFIG_PATH=$HOME/.openclaw-$OPENCLAW_PROFILE/openclaw.json
Environment=OPENCLAW_GATEWAY_PORT=18789
Environment=NODE_ENV=production
ExecStart=$(which openclaw) gateway run --port 18789
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# --- Runner service ---
sudo tee /etc/systemd/system/sebastian-runner.service > /dev/null << EOF
[Unit]
Description=Sebastian D. Hunter Runner
After=openclaw-gateway.service network-online.target
Wants=openclaw-gateway.service
Requires=openclaw-gateway.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $PROJECT_DIR/runner/run.sh
Restart=always
RestartSec=30
StandardOutput=append:$PROJECT_DIR/runner/runner.log
StandardError=append:$PROJECT_DIR/runner/runner.log

[Install]
WantedBy=multi-user.target
EOF

# --- Telegram bot service ---
sudo tee /etc/systemd/system/sebastian-tgbot.service > /dev/null << EOF
[Unit]
Description=Sebastian D. Hunter Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(which node) $PROJECT_DIR/runner/telegram_bot.js
Restart=always
RestartSec=10
StandardOutput=append:$PROJECT_DIR/runner/telegram_bot.log
StandardError=append:$PROJECT_DIR/runner/telegram_bot.log

[Install]
WantedBy=multi-user.target
EOF

# Allow the Telegram bot's service user to restart the managed services
# without prompting for a password. This keeps the command surface narrow.
sudo tee /etc/sudoers.d/sebastian-hunter-telegram > /dev/null << EOF
$USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN status openclaw-gateway.service, $SYSTEMCTL_BIN status sebastian-runner.service, $SYSTEMCTL_BIN status sebastian-tgbot.service, $SYSTEMCTL_BIN restart openclaw-gateway.service, $SYSTEMCTL_BIN restart sebastian-runner.service, $SYSTEMCTL_BIN restart sebastian-tgbot.service, $SYSTEMCTL_BIN start openclaw-gateway.service, $SYSTEMCTL_BIN start sebastian-runner.service, $SYSTEMCTL_BIN start sebastian-tgbot.service, $SYSTEMCTL_BIN stop openclaw-gateway.service, $SYSTEMCTL_BIN stop sebastian-runner.service, $SYSTEMCTL_BIN stop sebastian-tgbot.service
EOF
sudo chmod 440 /etc/sudoers.d/sebastian-hunter-telegram
sudo visudo -cf /etc/sudoers.d/sebastian-hunter-telegram > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable openclaw-gateway.service
sudo systemctl enable sebastian-runner.service
sudo systemctl enable sebastian-tgbot.service

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ Installation complete"
echo ""
echo "  Start services:"
echo "    sudo systemctl start openclaw-gateway"
echo "    sudo systemctl start sebastian-runner"
echo "    sudo systemctl start sebastian-tgbot"
echo ""
echo "  Check status:"
echo "    sudo systemctl status openclaw-gateway"
echo "    sudo systemctl status sebastian-runner"
echo "    sudo systemctl status sebastian-tgbot"
echo "    tail -30 ~/hunter/runner/runner.log"
echo "    tail -30 ~/hunter/runner/telegram_bot.log"
echo ""
echo "  If browser profile was not migrated:"
echo "    openclaw browser --browser-profile x-hunter start"
echo "    openclaw browser --browser-profile x-hunter open https://x.com/login"
echo "    # Log in manually, then restart runner"
echo "═══════════════════════════════════════════════════"
