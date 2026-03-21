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

const PROJECT_ROOT = config.PROJECT_ROOT;
const RUNNER_LOG = config.RUNNER_LOG_PATH;

function log(msg) {
  console.log(`[run] ${msg}`);
}

/** Run a node script, logging to runner.log. Failures swallowed. */
function runScript(scriptPath, opts = {}) {
  const { env = {}, captureOutput = false } = opts;
  const mergedEnv = { ...process.env, ...env };
  try {
    if (captureOutput) {
      return execSync(`node "${scriptPath}"`, {
        env: mergedEnv,
        encoding: 'utf-8',
        timeout: 120_000,
      }).trim();
    }
    execSync(`node "${scriptPath}" >> "${RUNNER_LOG}" 2>&1`, {
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
    runScript(path.join(PROJECT_ROOT, 'runner/reading_queue.js') + ' --mark-done', {
      env: { READING_CYCLE: String(cycle) },
    });
  }

  // ── 3. apply_ontology_delta.js ────────────────────────────────────────
  runScriptVerbose(path.join(PROJECT_ROOT, 'runner/apply_ontology_delta.js'));

  // ── 4. detect_drift.js ────────────────────────────────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/detect_drift.js'));

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
      } catch {}

      // 5d. archive.js + JOURNAL watchdog
      runScript(path.join(PROJECT_ROOT, 'runner/archive.js'));
      runScript(path.join(PROJECT_ROOT, 'runner/watchdog.js'), {
        env: { CYCLE_TYPE: 'JOURNAL' },
      });
    }
  }

  // ── 6. moltbook.js --heartbeat ────────────────────────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/moltbook.js') + ' --heartbeat');

  // ── 7. moltbook.js --post-checkpoint (retry pending) ─────────────────
  const checkpointPending = path.join(config.STATE_DIR, 'checkpoint_pending');
  if (fs.existsSync(checkpointPending)) {
    runScript(path.join(PROJECT_ROOT, 'runner/moltbook.js') + ' --post-checkpoint');
  }

  // ── 8. Retry pending checkpoint tweet ─────────────────────────────────
  const checkpointResult = path.join(config.STATE_DIR, 'checkpoint_result.txt');
  if (fs.existsSync(checkpointResult)) {
    try {
      const lines = fs.readFileSync(checkpointResult, 'utf-8').split('\n');
      let cpUrl = (lines[0] || '').trim();
      let cpTitle = (lines[1] || '').trim();
      const maxCp = 240 - cpUrl.length;
      if (cpTitle.length > maxCp) cpTitle = cpTitle.slice(0, maxCp) + '...';

      fs.writeFileSync(config.TWEET_DRAFT_PATH, `${cpTitle}\n${cpUrl}`);
      log(`retrying checkpoint tweet: ${cpUrl}`);

      // Run post_tweet.js once — check exit code to decide cleanup
      try {
        const out = execSync(`node "${path.join(PROJECT_ROOT, 'runner/post_tweet.js')}"`, {
          encoding: 'utf-8',
          timeout: 60_000,
        }).trim();
        if (out) console.log(out.split('\n').filter(l => l).join('\n'));
        // Success (exit 0) — remove result file
        fs.unlinkSync(checkpointResult);
      } catch {}
    } catch {}
  }

  // ── 9. reply.js (process pending replies) ─────────────────────────────
  runScriptVerbose(path.join(PROJECT_ROOT, 'scraper/reply.js'));
}

module.exports = { postBrowse };
