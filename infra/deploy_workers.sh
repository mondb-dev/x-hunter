#!/usr/bin/env bash
# infra/deploy_workers.sh — Build and deploy Cloud Run worker services
#
# Usage:
#   ./infra/deploy_workers.sh [verify|publish|all]
#
# Env vars (set these or edit defaults below):
#   GCP_PROJECT       — GCP project ID (default: sebastian-hunter)
#   GCP_REGION        — Region (default: us-central1)
#   DATABASE_URL      — Postgres connection string
#   GCS_DATA_BUCKET   — GCS bucket (default: sebastian-hunter-data)

set -euo pipefail

PROJECT="${GCP_PROJECT:-sebastian-hunter}"
REGION="${GCP_REGION:-us-central1}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/hunter"
BUCKET="${GCS_DATA_BUCKET:-sebastian-hunter-data}"

# Ensure Artifact Registry repo exists
gcloud artifacts repositories describe hunter \
  --project="$PROJECT" --location="$REGION" 2>/dev/null || \
  gcloud artifacts repositories create hunter \
    --repository-format=docker --location="$REGION" --project="$PROJECT"

deploy_verify() {
  echo "=== Building verify worker ==="
  cd workers/verify
  npm install 2>/dev/null || true

  gcloud builds submit \
    --project="$PROJECT" \
    --tag="${REGISTRY}/verify:latest" \
    .

  echo "=== Deploying verify worker ==="
  gcloud run deploy hunter-verify \
    --project="$PROJECT" \
    --region="$REGION" \
    --image="${REGISTRY}/verify:latest" \
    --platform=managed \
    --no-allow-unauthenticated \
    --memory=512Mi \
    --cpu=1 \
    --max-instances=3 \
    --min-instances=0 \
    --timeout=120 \
    --set-env-vars="DATABASE_URL=${DATABASE_URL},GCP_PROJECT=${PROJECT},PG_SSL=false" \
    --service-account="sebastian-hunter-ai@${PROJECT}.iam.gserviceaccount.com"

  cd ../..
  echo "=== verify worker deployed ==="
}

deploy_publish() {
  echo "=== Building publish worker ==="
  cd workers/publish
  npm install 2>/dev/null || true

  gcloud builds submit \
    --project="$PROJECT" \
    --tag="${REGISTRY}/publish:latest" \
    .

  echo "=== Deploying publish worker ==="
  gcloud run deploy hunter-publish \
    --project="$PROJECT" \
    --region="$REGION" \
    --image="${REGISTRY}/publish:latest" \
    --platform=managed \
    --no-allow-unauthenticated \
    --memory=256Mi \
    --cpu=1 \
    --max-instances=3 \
    --min-instances=0 \
    --timeout=60 \
    --set-env-vars="DATABASE_URL=${DATABASE_URL},GCP_PROJECT=${PROJECT},GCS_DATA_BUCKET=${BUCKET},PG_SSL=false" \
    --service-account="sebastian-hunter-ai@${PROJECT}.iam.gserviceaccount.com"

  cd ../..
  echo "=== publish worker deployed ==="

  # Set up Pub/Sub push subscription to publish worker
  PUBLISH_URL=$(gcloud run services describe hunter-publish \
    --project="$PROJECT" --region="$REGION" \
    --format='value(status.url)')

  echo "=== Setting up Pub/Sub push subscription ==="
  gcloud pubsub subscriptions describe claim-resolved-push \
    --project="$PROJECT" 2>/dev/null || \
  gcloud pubsub subscriptions create claim-resolved-push \
    --project="$PROJECT" \
    --topic=claim-resolved \
    --push-endpoint="${PUBLISH_URL}/claim-resolved" \
    --push-auth-service-account="sebastian-hunter-ai@${PROJECT}.iam.gserviceaccount.com" \
    --ack-deadline=60
}

TARGET="${1:-all}"

case "$TARGET" in
  verify)  deploy_verify ;;
  publish) deploy_publish ;;
  all)     deploy_verify; deploy_publish ;;
  *)       echo "Usage: $0 [verify|publish|all]"; exit 1 ;;
esac

echo ""
echo "Done. Worker URLs:"
gcloud run services list --project="$PROJECT" --region="$REGION" \
  --filter="metadata.name ~ hunter-" --format="table(metadata.name, status.url)"
