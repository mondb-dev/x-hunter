#!/bin/bash
# infra/deploy_web.sh — Build and deploy website to Cloud Run
# Run from project root: bash infra/deploy_web.sh
#
# Can be called from the VM after git push, or from local.
# Also syncs state data to GCS for the FUSE mount.

set -euo pipefail

PROJECT_ID="sebastian-hunter"
REGION="us-central1"
IMAGE="us-central1-docker.pkg.dev/${PROJECT_ID}/sebastian/web"
SERVICE="sebastian-web"
BUCKET="gs://sebastian-hunter-data"

echo "[deploy] syncing state data to GCS..."
DIRS="state journals checkpoints articles daily ponders landmarks"
for d in $DIRS; do
  if [ -d "$d" ]; then
    gsutil -m -q rsync -r "$d/" "${BUCKET}/${d}/"
  fi
done
[ -f manifesto.md ] && gsutil -q cp manifesto.md "${BUCKET}/manifesto.md"

echo "[deploy] building image..."
gcloud builds submit web/ \
  --tag "${IMAGE}:latest" \
  --timeout=600 \
  --quiet

echo "[deploy] deploying to Cloud Run..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}:latest" \
  --region "${REGION}" \
  --quiet

echo "[deploy] done: https://${SERVICE}-362753554748.${REGION}.run.app"
