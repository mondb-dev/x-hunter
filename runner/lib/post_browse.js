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

  // ── 2. reading_queue.js --mark-done (if reading URL was set) ──────────
  if (fs.existsSync(config.READING_URL_PATH) && fs.statSync(config.READING_URL_PATH).size > 0) {
    runScript(path.join(PROJECT_ROOT, 'runner/reading_queue.js'), {
      args: '--mark-done',
      env: { READING_CYCLE: String(cycle) },
    });
  }

  // ── 3. apply_ontology_delta.js ────────────────────────────────────────
  runScriptVerbose(path.join(PROJECT_ROOT, 'runner/apply_ontology_delta.js'));

  // ── 4. detect_drift.js ────────────────────────────────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/detect_drift.js'));

  // ── 4b. signal_detector.js (cross-axis anomaly detection) ─────────────
  runScript(path.join(PROJECT_ROOT, 'runner/signal_detector.js'));

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

  // ── 4e-pre. Routine embedding backfill (throttled to once per 2h) ─────────
  // Embeds new memory rows via text-embedding-004 → Postgres embeddings table.
  // Idempotent; skips already-embedded rows.
  {
    const embedStamp = path.join(config.STATE_DIR, '.last_embed_backfill');
    const lastEmbed = fs.existsSync(embedStamp) ? fs.statSync(embedStamp).mtimeMs : 0;
    if (Date.now() - lastEmbed > 2 * 60 * 60 * 1000) {
      runScript(path.join(PROJECT_ROOT, 'runner/backfill_embeddings.js'), {
        args: '--memory --batch 50',
      });
      try { fs.writeFileSync(embedStamp, new Date().toISOString()); } catch {}
    }
  }

  // ── 4e. Claim verification pipeline ─────────────────────────────────
  // Dispatch to Cloud Tasks worker if configured, else run inline
  const cloudTasks = require('./cloud_tasks');
  if (cloudTasks.isEnabled('verify')) {
    const dispatched = cloudTasks.enqueueVerifyCycle();
    log(dispatched ? 'verification dispatched to Cloud Tasks' : 'Cloud Tasks dispatch failed — running inline');
    if (!dispatched) {
      runScript(path.join(PROJECT_ROOT, 'runner/intelligence/verify_claims.js'));
    }
  } else {
    runScript(path.join(PROJECT_ROOT, 'runner/intelligence/verify_claims.js'));
  }

  // ── 4f. Verification pipeline runs but does NOT auto-post tweets ───
  // Verification data still updates for the /verified web page.
  // Verification tweet posting disabled — not part of new cadence.

  // ── 4g. Landmark special announcement (vocation / prediction confirmed) ──
  // Written by landmark/index.js step 7 when stage is special_vocation/prediction.
  const specialDraftPath = path.join(config.STATE_DIR, 'landmark_special_draft.txt');
  if (fs.existsSync(specialDraftPath) && fs.statSync(specialDraftPath).size > 0) {
    if (isXSuppressed('tweet')) {
      log(`landmark special tweet suppressed (${suppressionReason('tweet')})`);
    } else {
      const { postLandmarkSpecialTweet } = require('./post');
      const { ensureBrowser } = require('./browser');
      ensureBrowser();
      const result = postLandmarkSpecialTweet({ today, hour });
      if (result.posted) {
        log('Landmark special tweet posted');
      }
    }
  }

  // ── 5. Journal commit decision (4 sub-steps) ─────────────────────────
  const journalFile = path.join(config.JOURNALS_DIR, `${today}_${hour}.html`);
  const journalRelPath = `journals/${today}_${hour}.html`;

  // 5a. Check git porcelain for new journal file
  let hasJournal = false;
  try {
    const porcelain = execSync(
      `git -C "${PROJECT_ROOT}" status --porcelain -- "${today}_${hour}.html" journals/`,
      { encoding: 'utf-8', timeout: 10_000 }
    );
    hasJournal = porcelain.includes(journalRelPath);
  } catch {}

  if (hasJournal) {
    // 5b. Suppress failure journals
    if (isFailureJournal(journalFile)) {
      log('Browse journal is a failure cycle — suppressing commit/push/archive');
      try {
        execSync(`git -C "${PROJECT_ROOT}" checkout -- "${journalRelPath}"`, { stdio: 'ignore', timeout: 10_000 });
      } catch {
        try { fs.unlinkSync(journalFile); } catch {}
      }
    } else {
      // 5c. git add → commit → push
      log('Browse journal written — committing and pushing...');
      try {
        execSync(`git -C "${PROJECT_ROOT}" add journals/ state/`, { stdio: 'ignore', timeout: 10_000 });
        execSync(
          `git -C "${PROJECT_ROOT}" commit -m "journal: ${today} ${hour} (browse cycle ${cycle})"`,
          { stdio: 'ignore', timeout: 10_000 }
        );
        execSync(`git -C "${PROJECT_ROOT}" push origin main`, { stdio: 'ignore', timeout: 30_000 });
        log('browse journal pushed');
        triggerVercelDeploy(process.env.VERCEL_DEPLOY_HOOK || '');
      } catch {}

      // 5d. archive.js + JOURNAL watchdog
      runScript(path.join(PROJECT_ROOT, 'runner/archive.js'));
      runScript(path.join(PROJECT_ROOT, 'runner/watchdog.js'), {
        env: { CYCLE_TYPE: 'JOURNAL' },
      });
    }
  }

  // GCS sync — always runs so the website sees fresh data even when no new
  // journal was written (e.g. duplicate/sprint cycles). Throttled to once
  // per hour using a stamp file to avoid redundant rsync on every cycle.
  try {
    const syncStamp = path.join(config.STATE_DIR, '.last_gcs_sync');
    const lastSync = fs.existsSync(syncStamp) ? fs.statSync(syncStamp).mtimeMs : 0;
    if (Date.now() - lastSync > 55 * 60 * 1000 || hasJournal) {
      syncToGCS();
      fs.writeFileSync(syncStamp, new Date().toISOString());
    }
  } catch {}

  // ── 6. moltbook.js --heartbeat ────────────────────────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/moltbook.js'), { args: '--heartbeat' });

  // ── 7. moltbook.js --post-checkpoint (retry pending) ─────────────────
  const checkpointPending = path.join(config.STATE_DIR, 'checkpoint_pending');
  if (fs.existsSync(checkpointPending)) {
    runScript(path.join(PROJECT_ROOT, 'runner/moltbook.js'), { args: '--post-checkpoint' });
  }

  // ── 8. Retry pending checkpoint tweet (gist + website link) ────────────
  const checkpointResult = path.join(config.STATE_DIR, 'checkpoint_result.txt');
  if (fs.existsSync(checkpointResult)) {
    if (isXSuppressed('tweet')) {
      log(`checkpoint tweet suppressed (${suppressionReason('tweet')})`);
    } else {
    try {
      const lines = fs.readFileSync(checkpointResult, 'utf-8').split('\n');
      const cpTitle = (lines[1] || '').trim();
      // Extract checkpoint number for website link
      const cpNum = (cpTitle.match(/checkpoint\s+(\d+)/i) || [])[1] || '';
      const webUrl = cpNum
        ? `https://sebastianhunter.fun/checkpoint/${cpNum}`
        : 'https://sebastianhunter.fun/checkpoints';

      // Build a gist from the latest checkpoint file
      let gist = '';
      try {
        const cpDir = path.join(PROJECT_ROOT, 'checkpoints');
        const cpFiles = fs.readdirSync(cpDir).filter(f => f.endsWith('.md')).sort();
        if (cpFiles.length) {
          const latest = fs.readFileSync(path.join(cpDir, cpFiles[cpFiles.length - 1]), 'utf-8');
          // Extract interpretation section or first paragraph after frontmatter
          const body = latest.replace(/^---[\s\S]*?---\s*/, '');
          const para = body.split('\n\n').find(p => p.trim().length > 50 && !p.startsWith('#'));
          if (para) {
            gist = para.trim().replace(/\n/g, ' ');
            const maxLen = 240 - webUrl.length;
            if (gist.length > maxLen) gist = gist.slice(0, maxLen - 3) + '...';
          }
        }
      } catch {}

      if (!gist) gist = cpTitle; // fallback to title

      fs.writeFileSync(config.TWEET_DRAFT_PATH, `${gist}\n${webUrl}`);
      log(`checkpoint tweet: ${webUrl}`);

      try {
        const out = execSync(`node "${path.join(PROJECT_ROOT, 'runner/post_tweet.js')}"`, {
          encoding: 'utf-8',
          timeout: 60_000,
        }).trim();
        if (out) console.log(out.split('\n').filter(l => l).join('\n'));
        fs.unlinkSync(checkpointResult);
      } catch {}
    } catch {}
    }
  }

  // ── 9. reply.js (process pending replies) ─────────────────────────────
  if (isXSuppressed('reply')) {
    log(`reply processing suppressed (${suppressionReason('reply')})`);
  } else {
    runScriptVerbose(path.join(PROJECT_ROOT, 'scraper/reply.js'));
  }
}

module.exports = { postBrowse };
