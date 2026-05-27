#!/bin/bash
# runner/sync_from_vm.sh — pull key state from GCP VM to run Sebastian locally
#
# Syncs:
#   1. X session cookies (Chrome profile Default/Cookies)
#   2. All state files except large DBs (index.db, feed_buffer.jsonl)
#   3. Optionally: index.db (993MB) — skip with --no-index
#
# Usage:
#   bash runner/sync_from_vm.sh            # skip index.db
#   bash runner/sync_from_vm.sh --index    # also sync index.db (~1GB, slow)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VM=sebastian
ZONE=us-central1-a
PROJECT=sebastian-hunter
VM_USER=raymond_d_baldonado_gmail_com
VM_HOME="/home/$VM_USER"
SSH_ARGS="--zone=$ZONE --project=$PROJECT --tunnel-through-iap"

SYNC_INDEX=false
[ "$1" = "--index" ] && SYNC_INDEX=true

gcp_scp() {
  gcloud compute scp $SSH_ARGS "$VM:$1" "$2" 2>/dev/null
}

echo "=== Syncing from VM ($VM) ==="

# ── 1. Chrome cookies ─────────────────────────────────────────────────────────
echo "[1/3] Syncing X session cookies..."
CHROME_LOCAL="$HOME/.config/google-chrome/x-hunter/Default"
mkdir -p "$CHROME_LOCAL"
gcp_scp "$VM_HOME/.config/google-chrome/x-hunter/Default/Cookies" "$CHROME_LOCAL/Cookies"
echo "      Done — $CHROME_LOCAL/Cookies"

# ── 2. State files (exclude large DBs) ────────────────────────────────────────
echo "[2/3] Syncing state files (excluding index.db, feed_buffer.jsonl)..."
gcloud compute ssh $VM $SSH_ARGS --command "
  cd ~/hunter/state && \
  tar czf /tmp/state_sync.tar.gz \
    --exclude=index.db \
    --exclude=index.db-shm \
    --exclude=index.db-wal \
    --exclude='index.db.backup*' \
    --exclude=feed_buffer.jsonl \
    --exclude=sprints.db-shm \
    --exclude=sprints.db-wal \
    . 2>/dev/null
" 2>/dev/null
gcp_scp "/tmp/state_sync.tar.gz" "/tmp/state_sync.tar.gz"
tar xzf /tmp/state_sync.tar.gz -C "$PROJECT_ROOT/state/"
rm /tmp/state_sync.tar.gz
echo "      Done — $PROJECT_ROOT/state/"

# ── 3. index.db (optional, ~1GB) ─────────────────────────────────────────────
if [ "$SYNC_INDEX" = "true" ]; then
  echo "[3/3] Syncing index.db (~1GB — this will take a few minutes)..."
  gcp_scp "$VM_HOME/hunter/state/index.db" "$PROJECT_ROOT/state/index.db"
  echo "      Done — $PROJECT_ROOT/state/index.db"
else
  echo "[3/3] Skipping index.db (run with --index to include it)"
  echo "      Agent will work without it — FTS search degrades gracefully"
fi

echo ""
echo "=== Sync complete ==="
echo "Next: install launchd services, then fix billing or swap LLM."
