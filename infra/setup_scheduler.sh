#!/usr/bin/env bash
# infra/setup_scheduler.sh — Create Cloud Scheduler jobs for worker services
#
# These jobs trigger verification cycles and export regeneration on a schedule,
# independent of the VM's browse loop. The VM loop also dispatches verification
# via Cloud Tasks on each browse cycle — these schedulers act as a safety net
# and handle off-cycle verification.
#
# Usage: ./infra/setup_scheduler.sh

set -euo pipefail

PROJECT="${GCP_PROJECT:-sebastian-hunter}"
REGION="${GCP_LOCATION:-us-central1}"
SA="sebastian-hunter-ai@${PROJECT}.iam.gserviceaccount.com"

# Get worker URLs
VERIFY_URL=$(gcloud run services describe hunter-verify \
  --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)' 2>/dev/null || echo "")

PUBLISH_URL=$(gcloud run services describe hunter-publish \
  --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)' 2>/dev/null || echo "")

if [ -z "$VERIFY_URL" ] || [ -z "$PUBLISH_URL" ]; then
  echo "ERROR: Workers not deployed yet. Run deploy_workers.sh first."
  echo "  VERIFY_URL=$VERIFY_URL"
  echo "  PUBLISH_URL=$PUBLISH_URL"
  exit 1
fi

echo "Worker URLs:"
echo "  verify:  $VERIFY_URL"
echo "  publish: $PUBLISH_URL"

# ── Verification cycle: every 2 hours ────────────────────────────────────────
echo ""
echo "=== Creating verify-cycle scheduler (every 2h) ==="
gcloud scheduler jobs delete hunter-verify-cycle \
  --project="$PROJECT" --location="$REGION" --quiet 2>/dev/null || true

gcloud scheduler jobs create http hunter-verify-cycle \
  --project="$PROJECT" \
  --location="$REGION" \
  --schedule="0 */2 * * *" \
  --time-zone="UTC" \
  --uri="${VERIFY_URL}/verify-cycle" \
  --http-method=POST \
  --oidc-service-account-email="$SA" \
  --oidc-token-audience="$VERIFY_URL" \
  --attempt-deadline=120s \
  --description="Run claim verification cycle every 2 hours"

# ── Export regeneration: every 6 hours ───────────────────────────────────────
echo ""
echo "=== Creating export scheduler (every 6h) ==="
gcloud scheduler jobs delete hunter-export \
  --project="$PROJECT" --location="$REGION" --quiet 2>/dev/null || true

gcloud scheduler jobs create http hunter-export \
  --project="$PROJECT" \
  --location="$REGION" \
  --schedule="0 */6 * * *" \
  --time-zone="UTC" \
  --uri="${PUBLISH_URL}/export" \
  --http-method=POST \
  --oidc-service-account-email="$SA" \
  --oidc-token-audience="$PUBLISH_URL" \
  --attempt-deadline=60s \
  --description="Regenerate verification export JSON every 6 hours"

echo ""
echo "=== Scheduler jobs created ==="
gcloud scheduler jobs list --project="$PROJECT" --location="$REGION" \
  --filter="name ~ hunter-" --format="table(name, schedule, state, httpTarget.uri)"
