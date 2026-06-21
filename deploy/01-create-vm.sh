#!/bin/bash
# deploy/01-create-vm.sh — Create GCP project + VM for Sebastian
#
# Prerequisites:
#   - gcloud CLI installed: https://cloud.google.com/sdk/docs/install
#   - Logged in: gcloud auth login
#   - Billing account linked (script will prompt if needed)
#
# Usage:
#   bash deploy/01-create-vm.sh

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:-sebastian-hunter}"
REGION="us-central1"
ZONE="${REGION}-a"
VM_NAME="sebastian"
MACHINE_TYPE="e2-medium"       # 2 vCPU, 4 GB RAM — ~$24/mo
DISK_SIZE="30"                 # GB (code + Chrome profile + SQLite + headroom)
IMAGE_FAMILY="debian-12"
IMAGE_PROJECT="debian-cloud"

echo "═══════════════════════════════════════════════════"
echo "  Sebastian D. Hunter — GCP VM Provisioning"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Project:  $PROJECT_ID"
echo "  Zone:     $ZONE"
echo "  Machine:  $MACHINE_TYPE (2 vCPU, 4 GB)"
echo "  Disk:     ${DISK_SIZE} GB SSD"
echo ""

# ── Step 1: Ensure gcloud is available ────────────────────────────────────────
if ! command -v gcloud &>/dev/null; then
  echo "ERROR: gcloud CLI not found."
  echo "Install: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# ── Step 2: Create project (if not exists) ────────────────────────────────────
echo "[1/6] Checking GCP project..."
if gcloud projects describe "$PROJECT_ID" &>/dev/null; then
  echo "  → Project '$PROJECT_ID' exists"
else
  echo "  → Creating project '$PROJECT_ID'..."
  gcloud projects create "$PROJECT_ID" --name="Sebastian Hunter"
fi
gcloud config set project "$PROJECT_ID"

# ── Step 3: Link billing ─────────────────────────────────────────────────────
echo "[2/6] Checking billing..."
BILLING_ENABLED=$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo "False")
if [ "$BILLING_ENABLED" != "True" ]; then
  echo ""
  echo "  ⚠  Billing is not linked to project '$PROJECT_ID'."
  echo "  Available billing accounts:"
  gcloud billing accounts list --format='table(name, displayName, open)'
  echo ""
  echo "  Link billing with:"
  echo "    gcloud billing projects link $PROJECT_ID --billing-account=ACCOUNT_ID"
  echo ""
  echo "  Then re-run this script."
  exit 1
fi
echo "  → Billing linked"

# ── Step 4: Enable Compute Engine API ─────────────────────────────────────────
echo "[3/6] Enabling Compute Engine API..."
gcloud services enable compute.googleapis.com --quiet

# ── Step 5: Create firewall rule for SSH ──────────────────────────────────────
echo "[4/6] Configuring firewall..."
if ! gcloud compute firewall-rules describe allow-ssh --project="$PROJECT_ID" &>/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-ssh \
    --project="$PROJECT_ID" \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:22 \
    --source-ranges=0.0.0.0/0 \
    --quiet
  echo "  → SSH firewall rule created"
else
  echo "  → SSH firewall rule exists"
fi

# ── Step 6: Create VM ────────────────────────────────────────────────────────
echo "[5/6] Creating VM '$VM_NAME'..."
if gcloud compute instances describe "$VM_NAME" --zone="$ZONE" &>/dev/null 2>&1; then
  echo "  → VM '$VM_NAME' already exists in $ZONE"
else
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --boot-disk-size="${DISK_SIZE}GB" \
    --boot-disk-type=pd-ssd \
    --metadata=enable-oslogin=TRUE \
    --scopes=default \
    --quiet
  echo "  → VM created"
fi

# ── Step 7: Wait for SSH ─────────────────────────────────────────────────────
echo "[6/6] Waiting for SSH..."
for i in $(seq 1 12); do
  if gcloud compute ssh "$VM_NAME" --zone="$ZONE" --command="echo ok" --quiet 2>/dev/null; then
    break
  fi
  echo "  → Waiting... (${i}/12)"
  sleep 10
done

# ── Done ──────────────────────────────────────────────────────────────────────
EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ VM ready"
echo ""
echo "  SSH:  gcloud compute ssh $VM_NAME --zone=$ZONE"
echo "  IP:   $EXTERNAL_IP"
echo ""
echo "  Next: bash deploy/02-migrate-data.sh"
echo "═══════════════════════════════════════════════════"
