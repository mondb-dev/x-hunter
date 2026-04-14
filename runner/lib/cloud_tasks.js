'use strict';

/**
 * runner/lib/cloud_tasks.js — Cloud Tasks dispatch helper
 *
 * Enqueues HTTP tasks to Cloud Run worker services via Cloud Tasks.
 * Falls back gracefully when Cloud Tasks is not configured (local dev, VM without env vars).
 *
 * Env vars:
 *   VERIFY_WORKER_URL    — Cloud Run URL for verify worker (e.g. https://hunter-verify-xxx.run.app)
 *   PUBLISH_WORKER_URL   — Cloud Run URL for publish worker
 *   GCP_PROJECT          — GCP project ID (default: sebastian-hunter)
 *   GCP_LOCATION         — Cloud Tasks region (default: us-central1)
 *   CLOUD_TASKS_SA_EMAIL — Service account for OIDC token (default: inferred)
 */

const { execSync } = require('child_process');

const GCP_PROJECT = process.env.GCP_PROJECT || 'sebastian-hunter';
const GCP_LOCATION = process.env.GCP_LOCATION || 'us-central1';
const VERIFY_URL = process.env.VERIFY_WORKER_URL || '';
const PUBLISH_URL = process.env.PUBLISH_WORKER_URL || '';

function log(msg) {
  console.log(`[cloud_tasks] ${msg}`);
}

/**
 * Check if Cloud Tasks dispatch is enabled for a given worker.
 */
function isEnabled(worker) {
  if (worker === 'verify') return !!VERIFY_URL;
  if (worker === 'publish') return !!PUBLISH_URL;
  return false;
}

/**
 * Enqueue a task via gcloud CLI.
 *
 * Uses gcloud instead of the Node.js client library to avoid adding
 * @google-cloud/tasks as a dependency to the runner (which runs on VM).
 *
 * @param {Object} opts
 * @param {string} opts.queue     — Queue name (e.g. 'sebastian-verify')
 * @param {string} opts.url       — Full URL (e.g. 'https://hunter-verify-xxx.run.app/verify-cycle')
 * @param {string} [opts.body]    — JSON body string
 * @param {string} [opts.method]  — HTTP method (default: POST)
 * @returns {boolean} true if enqueued successfully
 */
function enqueue({ queue, url, body, method = 'POST' }) {
  try {
    const args = [
      'gcloud', 'tasks', 'create-http-task',
      `--queue=${queue}`,
      `--location=${GCP_LOCATION}`,
      `--project=${GCP_PROJECT}`,
      `--url=${url}`,
      `--method=${method}`,
      '--oidc-service-account-email=' +
        (process.env.CLOUD_TASKS_SA_EMAIL || `sebastian-hunter-ai@${GCP_PROJECT}.iam.gserviceaccount.com`),
    ];

    if (body) {
      args.push(`--body-content=${body}`);
      args.push('--header=Content-Type: application/json');
    }

    execSync(args.join(' '), { stdio: 'pipe', timeout: 15_000 });
    log(`enqueued: ${queue} → ${url}`);
    return true;
  } catch (err) {
    log(`enqueue failed (${queue}): ${err.message}`);
    return false;
  }
}

/**
 * Enqueue a verification cycle.
 * @returns {boolean} true if dispatched to Cloud Tasks
 */
function enqueueVerifyCycle() {
  if (!VERIFY_URL) return false;
  return enqueue({
    queue: 'sebastian-verify',
    url: `${VERIFY_URL}/verify-cycle`,
  });
}

/**
 * Enqueue verification of a single claim.
 * @param {string} claimId
 * @returns {boolean}
 */
function enqueueVerifyClaim(claimId) {
  if (!VERIFY_URL) return false;
  return enqueue({
    queue: 'sebastian-verify',
    url: `${VERIFY_URL}/verify-claim`,
    body: JSON.stringify({ claim_id: claimId }),
  });
}

/**
 * Enqueue export regeneration.
 * @returns {boolean}
 */
function enqueueExport() {
  if (!PUBLISH_URL) return false;
  return enqueue({
    queue: 'sebastian-publish',
    url: `${PUBLISH_URL}/export`,
  });
}

module.exports = {
  isEnabled,
  enqueue,
  enqueueVerifyCycle,
  enqueueVerifyClaim,
  enqueueExport,
};
