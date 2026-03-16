#!/bin/bash
# deploy/02-migrate-data.sh — Transfer local data to GCP VM
#
# Transfers:
#   1. Git repo (clone on VM)
#   2. .env (secrets)
#   3. Chrome browser profile (~1.2 GB — X login session)
#   4. OpenClaw config (~/.openclaw/ agent configs)
#   5. state/index.db (SQLite, gitignored — ~160 MB)
#   6. Vertex AI service account JSON
#
# Prerequisites:
#   - VM created via 01-create-vm.sh
#   - gcloud CLI authenticated
#
# Usage:
#   bash deploy/02-migrate-data.sh

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:-sebastian-hunter}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM_NAME="${GCP_VM_NAME:-sebastian}"
LOCAL_PROJECT="/Users/mondb/Documents/Projects/hunter"

echo "═══════════════════════════════════════════════════"
echo "  Sebastian D. Hunter — Data Migration"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  From: $LOCAL_PROJECT"
echo "  To:   $VM_NAME ($ZONE)"
echo ""

# Helper: gcloud SCP wrapper
gscp() {
  gcloud compute scp "$@" --zone="$ZONE" --project="$PROJECT_ID" --quiet
}

# Helper: gcloud SSH wrapper
gssh() {
  gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="$1" --quiet
}

# ── Step 1: Clone repo on VM ─────────────────────────────────────────────────
echo "[1/7] Cloning repo on VM..."
# Read GitHub token from .env
GITHUB_TOKEN=$(grep '^GITHUB_TOKEN=' "$LOCAL_PROJECT/.env" | cut -d'=' -f2-)
GITHUB_REPO=$(grep '^GITHUB_REPO=' "$LOCAL_PROJECT/.env" | cut -d'=' -f2-)

if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_REPO" ]; then
  echo "ERROR: GITHUB_TOKEN or GITHUB_REPO not found in .env"
  exit 1
fi

gssh "if [ -d ~/hunter ]; then echo '  → repo exists, pulling...'; cd ~/hunter && git pull; else git clone https://x-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git ~/hunter; fi"

# ── Step 2: Transfer .env ────────────────────────────────────────────────────
echo "[2/7] Transferring .env..."
gscp "$LOCAL_PROJECT/.env" "$VM_NAME:~/hunter/.env"

# ── Step 3: Transfer Vertex AI service account ───────────────────────────────
echo "[3/7] Transferring Vertex AI credentials..."
VERTEX_CREDS=$(grep '^GOOGLE_APPLICATION_CREDENTIALS=' "$LOCAL_PROJECT/.env" | cut -d'=' -f2-)
if [ -n "$VERTEX_CREDS" ] && [ -f "$VERTEX_CREDS" ]; then
  # Copy to same relative location on VM
  CREDS_BASENAME=$(basename "$VERTEX_CREDS")
  gscp "$VERTEX_CREDS" "$VM_NAME:~/hunter/$CREDS_BASENAME"
  # Update .env to point to new location
  gssh "sed -i 's|GOOGLE_APPLICATION_CREDENTIALS=.*|GOOGLE_APPLICATION_CREDENTIALS=/home/\$(whoami)/hunter/$CREDS_BASENAME|' ~/hunter/.env"
  echo "  → Credentials transferred + .env path updated"
else
  echo "  → No Vertex credentials file found (skipping)"
fi

# ── Step 4: Transfer Chrome browser profile ──────────────────────────────────
echo "[4/7] Transferring Chrome browser profile (~1.2 GB)..."
echo "  → This may take a few minutes..."

CHROME_PROFILE="$HOME/.openclaw/browser/x-hunter"
if [ -d "$CHROME_PROFILE/user-data" ]; then
  # Create tarball (exclude cache dirs to reduce size)
  echo "  → Compressing browser profile..."
  TMPTAR="/tmp/chrome-profile-x-hunter.tar.gz"
  tar -czf "$TMPTAR" \
    -C "$HOME/.openclaw/browser" \
    --exclude='*/Cache/*' \
    --exclude='*/Code Cache/*' \
    --exclude='*/Service Worker/CacheStorage/*' \
    --exclude='*/GPUCache/*' \
    --exclude='*/ShaderCache/*' \
    "x-hunter"

  TARSIZE=$(du -h "$TMPTAR" | cut -f1)
  echo "  → Compressed to $TARSIZE — uploading..."

  gscp "$TMPTAR" "$VM_NAME:/tmp/chrome-profile-x-hunter.tar.gz"
  gssh "mkdir -p ~/.openclaw/browser && tar -xzf /tmp/chrome-profile-x-hunter.tar.gz -C ~/.openclaw/browser/ && rm -f /tmp/chrome-profile-x-hunter.tar.gz"
  rm -f "$TMPTAR"
  echo "  → Browser profile transferred (X session cookies preserved)"
else
  echo "  → WARNING: No Chrome profile found at $CHROME_PROFILE"
  echo "    You'll need to log in to X on the VM manually."
fi

# ── Step 5: Transfer OpenClaw config ─────────────────────────────────────────
echo "[5/7] Transferring OpenClaw config..."

# Main config (agent definitions, model settings)
gssh "mkdir -p ~/.openclaw/agents/x-hunter/agent ~/.openclaw/agents/x-hunter/sessions ~/.openclaw/agents/x-hunter-tweet/agent ~/.openclaw/agents/x-hunter-tweet/sessions"

# Transfer agent auth files
for AGENT in x-hunter x-hunter-tweet; do
  AGENT_DIR="$HOME/.openclaw/agents/$AGENT/agent"
  if [ -d "$AGENT_DIR" ]; then
    gscp --recurse "$AGENT_DIR/" "$VM_NAME:~/.openclaw/agents/$AGENT/agent/"
  fi
done

# Transfer main openclaw.json — but patch workspace paths for Linux
cp "$HOME/.openclaw/openclaw.json" /tmp/openclaw-vm.json
# Replace macOS paths with Linux home directory paths
gssh "echo \$HOME" > /tmp/vm_home.txt 2>/dev/null || true
VM_HOME=$(cat /tmp/vm_home.txt 2>/dev/null | tr -d '\n' || echo "/home/$(whoami)")
sed -i.bak "s|/Users/mondb/Documents/Projects/hunter|${VM_HOME}/hunter|g" /tmp/openclaw-vm.json
sed -i.bak "s|/Users/mondb|${VM_HOME}|g" /tmp/openclaw-vm.json
# Remove macOS LaunchAgent references
gscp /tmp/openclaw-vm.json "$VM_NAME:~/.openclaw/openclaw.json"
rm -f /tmp/openclaw-vm.json /tmp/openclaw-vm.json.bak /tmp/vm_home.txt

# Transfer x-hunter profile config
if [ -d "$HOME/.openclaw-x-hunter" ]; then
  gssh "mkdir -p ~/.openclaw-x-hunter/logs"
  if [ -f "$HOME/.openclaw-x-hunter/openclaw.json" ]; then
    gscp "$HOME/.openclaw-x-hunter/openclaw.json" "$VM_NAME:~/.openclaw-x-hunter/openclaw.json"
  fi
fi

echo "  → OpenClaw config transferred"

# ── Step 6: Transfer SQLite database ─────────────────────────────────────────
echo "[6/7] Transferring SQLite database (~160 MB)..."
if [ -f "$LOCAL_PROJECT/state/index.db" ]; then
  gscp "$LOCAL_PROJECT/state/index.db" "$VM_NAME:~/hunter/state/index.db"
  echo "  → index.db transferred"
else
  echo "  → WARNING: state/index.db not found (skipping)"
fi

# Also transfer scraper's hunter.db if it exists
if [ -f "$LOCAL_PROJECT/scraper/hunter.db" ]; then
  gscp "$LOCAL_PROJECT/scraper/hunter.db" "$VM_NAME:~/hunter/scraper/hunter.db"
  echo "  → scraper/hunter.db transferred"
fi

# ── Step 7: Transfer any gitignored state files ──────────────────────────────
echo "[7/7] Transferring gitignored state files..."
for F in state/ponder_state.json state/checkpoint_pending state/curiosity_directive.txt state/reading_url.txt state/reply_queue.jsonl state/follow_queue.jsonl state/seen_ids.json; do
  if [ -f "$LOCAL_PROJECT/$F" ]; then
    gscp "$LOCAL_PROJECT/$F" "$VM_NAME:~/hunter/$F"
    echo "  → $F"
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ Data migration complete"
echo ""
echo "  Next: SSH into VM and run the install script:"
echo ""
echo "    gcloud compute ssh $VM_NAME --zone=$ZONE"
echo "    cd ~/hunter && bash deploy/03-install.sh"
echo "═══════════════════════════════════════════════════"
