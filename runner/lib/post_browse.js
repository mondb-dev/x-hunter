'use strict';

/**
 * runner/lib/post_browse.js — post-browse pipeline (9 top-level operations)
 *
 * Ported 1:1 from run.sh lines ~502-575 (after browse agent_run,
 * before the quote/tweet elif blocks).
 *
 * Includes the journal commit decision with failure suppression,
 * moltbook heartbeat, checkpoint tweet retry, and reply processing.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { triggerVercelDeploy, syncToGCS } = require('./git');
const { isXSuppressed, suppressionReason } = require('./x_control');

const PROJECT_ROOT = config.PROJECT_ROOT;
const RUNNER_LOG = config.RUNNER_LOG_PATH;

function log(msg) {
  console.log(`[run] ${msg}`);
}

/** Run a node script, logging to runner.log. Failures swallowed. */
function runScript(scriptPath, opts = {}) {
  const { env = {}, captureOutput = false, args = '' } = opts;
  const mergedEnv = { ...process.env, ...env };
  try {
    if (captureOutput) {
      return execSync(`node "${scriptPath}" ${args}`, {
        env: mergedEnv,
        encoding: 'utf-8',
        timeout: 120_000,
      }).trim();
    }
    execSync(`node "${scriptPath}" ${args} >> "${RUNNER_LOG}" 2>&1`, {
      env: mergedEnv,
      shell: true,
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    // || true
  }
  return '';
}

/** Run a node script, logging output to both console and runner.log. */
function runScriptVerbose(scriptPath, opts = {}) {
  const { env = {} } = opts;
  const mergedEnv = { ...process.env, ...env };
  try {
    const out = execSync(`node "${scriptPath}" 2>&1`, {
      env: mergedEnv,
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
    if (out) console.log(out);
  } catch {}
}

/**
 * Failure phrase patterns — journals containing these are suppressed.
 * Matches bash: grep -qi "browser control service\|browser.*unavailable\|
 *   unable to perform its core function\|no new observations"
 */
const FAILURE_PATTERNS = [
  /browser control service/i,
  /browser.*unavailable/i,
  /unable to perform its core function/i,
  /no new observations/i,
];

function isFailureJournal(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return FAILURE_PATTERNS.some(p => p.test(content));
  } catch {
    return false;
  }
}

/**
 * postBrowse({ cycle, today, hour })
 *
 * Runs the 9-step post-browse pipeline.
 *
 * @param {object} opts
 * @param {number} opts.cycle - current cycle number
 * @param {string} opts.today - YYYY-MM-DD
 * @param {string} opts.hour  - HH (zero-padded)
 */
function postBrowse({ cycle, today, hour }) {
  // ── 1. cleanup_tabs.js (close excess Chrome tabs) ─────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/cleanup_tabs.js'));

  // ─�� 2. reading_queue.js --mark-done (if reading URL was set) ──────────
  if (fs.existsSync(config.READING_URL_PATH) && fs.statSync(config.READING_URL_PATH).size > 0) {
    runScript(path.join(PROJECT_ROOT, 'runner/reading_queue.js'), {
      args: '--mark-done',
      env: { READING_CYCLE: String(cycle) },
    });
  }

  // ── 2b. redundancy_damper.js (dampen belief updates before applying) ──
  runScriptVerbose(path.join(PROJECT_ROOT, 'runner/tools/redundancy_damper.js'));

  // ── 3. apply_ontology_delta.js ────────────────────────────────────────
  runScriptVerbose(path.join(PROJECT_ROOT, 'runner/apply_ontology_delta.js'));

  // ── 3b. Merge claim tracker delta before verification/export ──────────
  const hadClaimTrackerDelta = fs.existsSync(config.CLAIM_TRACKER_DELTA_PATH) &&
    fs.statSync(config.CLAIM_TRACKER_DELTA_PATH).size > 0;
  runScript(path.join(PROJECT_ROOT, 'runner/apply_claim_tracker_delta.js'));

  // ── 4. detect_drift.js ────────────────────���───────────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/detect_drift.js'));

  // ── 4b. signal_detector.js (cross-axis anomaly detection) ─────────────
  runScript(path.join(PROJECT_ROOT, 'runner/signal_detector.js'));

  // ── 4b-landmark. Landmark event detection (throttled to once per 4h) ──
  {
    const landmarkStamp = path.join(config.STATE_DIR, '.last_landmark_scan');
    const lastLandmark = fs.existsSync(landmarkStamp) ? fs.statSync(landmarkStamp).mtimeMs : 0;
    if (Date.now() - lastLandmark > 4 * 60 * 60 * 1000) {
      runScript(path.join(PROJECT_ROOT, 'runner/landmark/index.js'));
      try { fs.writeFileSync(landmarkStamp, new Date().toISOString()); } catch {}
    }
  }

  // ── 4c. Post signal tweet if signal_draft.txt was written ─────────────
  const signalDraftPath = path.join(config.STATE_DIR, 'signal_draft.txt');
  if (fs.existsSync(signalDraftPath) && fs.statSync(signalDraftPath).size > 0) {
    const { postSignalTweet } = require('./post');
    const { ensureBrowser } = require('./browser');
    ensureBrowser();
    const signalResult = postSignalTweet({ today, hour });
    if (signalResult.posted) {
      log('Signal tweet posted — committing state...');
    }
  }

  // ── 4d. Predictive prompt (max 1/day, only when 3+ axes drifting) ───
  runScript(path.join(PROJECT_ROOT, 'runner/predictive_prompt.js'));

  // ── 4d-post. Post prediction tweet if draft exists ────────────────
  const predDraftPath = path.join(config.STATE_DIR, 'prediction_draft.txt');
  if (fs.existsSync(predDraftPath) && fs.statSync(predDraftPath).size > 0) {
    if (isXSuppressed('tweet')) {
      log(`prediction tweet suppressed (${suppressionReason('tweet')})`);
    } else {
      const { postPredictionTweet } = require('./post');
      const { ensureBrowser } = require('./browser');
      ensureBrowser();
      const predResult = postPredictionTweet({ today, hour });
      if (predResult.posted) {
        log('Prediction tweet posted');
      }
    }
  }

  // ── 4d-traj. Axis trajectory summary (throttled to once per 2h) ───────────
  {
    const trajStamp = path.join(config.STATE_DIR, '.last_trajectory');
    const lastTraj = fs.existsSync(trajStamp) ? fs.statSync(trajStamp).mtimeMs : 0;
    if (Date.now() - lastTraj > 2 * 60 * 60 * 1000) {
      runScript(path.join(PROJECT_ROOT, 'runner/axis_trajectory.js'));
      try { fs.writeFileSync(trajStamp, new Date().toISOString()); } catch {}
    }
  }

  // ── 5. Journal commit logic ───────────────────────────────────────────
  const journalPath = path.join(PROJECT_ROOT, `journals/${today}_${hour}.html`);
  if (fs.existsSync(journalPath) && !isFailureJournal(journalPath)) {
    log('Committing journal...');
    execSync(
      `git add "${journalPath}" && git commit -m "journal: ${today} ${hour}:00"`,
      { stdio: 'ignore' }
    );
  }

  // ── 6. Moltbook heartbeat (if enabled) ────────────────────────────────
  if (config.MOLTBOOK_ENABLED) {
    runScript(path.join(PROJECT_ROOT, 'runner/moltbook_heartbeat.js'));
  }

  // ── 7. Checkpoint tweet retry (if needed) ──────���──────────────────────
  const checkpointTweetNeeded = path.join(config.STATE_DIR, 'checkpoint_tweet_needed.txt');
  if (fs.existsSync(checkpointTweetNeeded)) {
    if (isXSuppressed('tweet')) {
      log(`checkpoint tweet suppressed (${suppressionReason('tweet')})`);
    } else {
      const { postCheckpointTweet } = require('./post');
      const { ensureBrowser } = require('./browser');
      ensureBrowser();
      postCheckpointTweet(); // handles its own state/cleanup
    }
  }

  // ── 8. Reply processing (if not suppressed) ───────────────────────────
  if (isXSuppressed('reply')) {
    log(`reply processing suppressed (${suppressionReason('reply')})`);
  } else {
    runScript(path.join(PROJECT_ROOT, 'scraper/reply.js'));
  }

  // ── 9. Vercel deploy + GCS sync (if changes were committed) ───────────
  const changes = execSync('git status --porcelain=v1', { encoding: 'utf-8' });
  if (changes.length > 0) {
    log('Changes detected, triggering sync...');
    syncToGCS();
    triggerVercelDeploy();
  } else {
    log('No changes to sync.');
  }

  // Final cleanup
  if (hadClaimTrackerDelta) {
    try { fs.unlinkSync(config.CLAIM_TRACKER_DELTA_PATH); } catch {}
  }
}

module.exports = { postBrowse };
