'use strict';

/**
 * runner/lib/daily.js — daily maintenance block
 *
 * Ported 1:1 from run.sh lines 806-970.
 * Self-gates to once per 24h via state/last_daily_at.txt.
 * Runs 19 operations in 5 groups with 5 embedded tweet-posting subflows.
 *
 * All operations are synchronous to match bash behavior.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ensureBrowser } = require('./browser');
const { postLinkTweet, postSimpleTweet } = require('./post');
const { commitAndPush, triggerVercelDeploy } = require('./git');

function log(msg) {
  console.log(`[daily] ${msg}`);
}

/**
 * Run a runner/*.js script, suppress all errors.
 * Stdout/stderr go to runner.log (stdio: 'ignore' from caller perspective).
 */
function runScript(script, args = '') {
  const sp = path.join(config.RUNNER_DIR, script);
  const cmd = args
    ? `node "${sp}" ${args} >> "${config.RUNNER_LOG_PATH}" 2>&1`
    : `node "${sp}" >> "${config.RUNNER_LOG_PATH}" 2>&1`;
  try {
    execSync(cmd, { shell: true, stdio: 'ignore', timeout: 300000 });
  } catch {}
}

function exists(fp) {
  try { return fs.existsSync(fp); } catch { return false; }
}

function sleepSec(n) {
  if (n > 0) execSync(`sleep ${n}`, { stdio: 'ignore' });
}

// ── Self-gate ────────────────────────────────────────────────────────────────

/**
 * Check whether 24h have elapsed since the last daily run.
 * @returns {boolean} true if daily block should fire
 */
function shouldRun() {
  const lastFile = config.LAST_DAILY_PATH;
  const nowEpoch = Math.floor(Date.now() / 1000);
  let lastEpoch = 0;
  try {
    lastEpoch = parseInt(fs.readFileSync(lastFile, 'utf-8').trim(), 10) || 0;
  } catch {}
  const elapsed = nowEpoch - lastEpoch;
  if (elapsed < 86400) return false;
  log(`── Daily block firing (${elapsed}s since last) ──`);
  return true;
}

/**
 * Mark the daily block as complete (write epoch to last_daily_at.txt).
 */
function markComplete() {
  const nowEpoch = Math.floor(Date.now() / 1000);
  fs.writeFileSync(config.LAST_DAILY_PATH, String(nowEpoch));
  log('daily block complete, next in ~24h');
}

// ── Sub-sections ─────────────────────────────────────────────────────────────

/**
 * 1. Reports: belief report + article + moltbook article post + article tweet
 * Bash: lines 821-862
 */
function reports() {
  // Daily ontology snapshot (lightweight — always runs first)
  runScript('daily_snapshot.js');

  // Intelligence pipeline: backfill source credibility → generate conflict claims → export
  try {
    const backfillScript = path.join(config.RUNNER_DIR, 'intelligence', 'backfill_behavior.js');
    execSync(`node "${backfillScript}" >> "${config.RUNNER_LOG_PATH}" 2>&1`, {
      shell: true, stdio: 'ignore', timeout: 60000,
    });
  } catch {}
  try {
    const generateScript = path.join(config.RUNNER_DIR, 'intelligence', 'generate_conflict_claims.js');
    execSync(`node "${generateScript}" >> "${config.RUNNER_LOG_PATH}" 2>&1`, {
      shell: true, stdio: 'ignore', timeout: 300000,
    });
  } catch {}
  try {
    const exportScript = path.join(config.RUNNER_DIR, 'intelligence', 'export.js');
    execSync(`node "${exportScript}" >> "${config.RUNNER_LOG_PATH}" 2>&1`, {
      shell: true, stdio: 'ignore', timeout: 60000,
    });
  } catch {}

  // Daily belief report
  runScript('generate_daily_report.js');

  // Capture detection — "am I being captured by one source/cluster?"
  runScript('capture_detection.js');

  // Posts quality assessment (LLM-assisted)
  runScript('posts_assessment.js');

  // Write article from journals + beliefs, generate cover art, post to Moltbook
  runScript('write_article.js');

  // Article cover image (Imagen 4) + inline images
  const today = new Date().toISOString().slice(0, 10);
  runScript('article_art.js', `--date ${today}`);

  // Copy generated images to web/public for the website
  const imgSrc = path.join(config.PROJECT_ROOT, 'articles', 'images');
  const imgDst = path.join(config.PROJECT_ROOT, 'web', 'public', 'images', 'articles');
  try {
    fs.mkdirSync(imgDst, { recursive: true });
    let copied = 0;
    if (fs.existsSync(imgSrc)) {
      for (const f of fs.readdirSync(imgSrc)) {
        if (f.startsWith(today) && f.endsWith('.png')) {
          fs.copyFileSync(path.join(imgSrc, f), path.join(imgDst, f));
          copied++;
        }
      }
    }
    if (copied > 0) log(`copied ${copied} article image(s) to web/public/images/articles/`);
  } catch (err) {
    log(`image copy failed: ${err.message}`);
  }

  runScript('moltbook.js', '--post-article');

  // Daily process reflection — may write a new META proposal if a concrete gap emerged
  runScript('process_reflection.js');

  // Browser settle + ensure healthy for daily tweets
  sleepSec(15);
  ensureBrowser();

  // Article tweet (2-attempt retry via postLinkTweet)
  postLinkTweet({ resultFile: 'article_result.txt', maxTitleChars: 255 });
}

/**
 * 2. Checkpoint: generate + vocation + bio + moltbook + checkpoint tweet
 * Bash: lines 863-890
 */
function checkpoint() {
  runScript('generate_checkpoint.js');
  runScript('evaluate_vocation.js');
  runScript('update_bio.js');
  runScript('moltbook.js', '--post-checkpoint');

  // Checkpoint tweet (single-attempt, resultFile mode, 60s gap)
  postSimpleTweet({ resultFile: 'checkpoint_result.txt', maxTitleChars: 240, gap: 60 });
}

/**
 * 3. Ponder: ponder + plan tweet + ponder tweet + moltbook ponder + deep_dive + decision
 * Bash: lines 891-920
 *
 * NOTE: ponder_tweet.txt posting has a special side-effect: touch ponder_post_pending.
 * This is NOT in postSimpleTweet (generic) — handled here explicitly.
 */
function ponder() {
  runScript('ponder.js');

  // Plan announcement tweet (source file mode, 60s gap)
  postSimpleTweet({ sourceFile: 'plan_tweet.txt', gap: 60 });

  // Ponder declaration tweet — special: must touch ponder_post_pending flag after
  const ponderTweetPath = path.join(config.STATE_DIR, 'ponder_tweet.txt');
  if (exists(ponderTweetPath)) {
    const draftPath = config.TWEET_DRAFT_PATH;
    try { fs.copyFileSync(ponderTweetPath, draftPath); } catch {}
    try {
      execSync(`node "${path.join(config.RUNNER_DIR, 'post_tweet.js')}"`, { stdio: 'ignore', timeout: 120000 });
    } catch {}
    try { fs.unlinkSync(ponderTweetPath); } catch {}
    log('ponder declaration tweet posted');
    // Flag Moltbook ponder post as pending — retries each daily cycle until success
    try {
      fs.writeFileSync(path.join(config.STATE_DIR, 'ponder_post_pending'), '');
    } catch {}
    sleepSec(10); // rate-limit gap (10s, not 60s — matches bash)
  }

  // Moltbook ponder post — retries every daily cycle until flag cleared
  if (exists(path.join(config.STATE_DIR, 'ponder_post_pending'))) {
    runScript('moltbook.js', '--post-ponder');
  }

  // Ponder pipeline: self-gating scripts
  runScript('deep_dive.js');
  runScript('decision.js');
}

/**
 * 4. Sprint: sprint manager + sprint update + sprint tweet + moltbook sprint
 * Bash: lines 921-935
 */
function sprint() {
  runScript('sprint_manager.js');
  runScript('sprint_update.js');

  // Sprint progress tweet (source file mode, no gap — matches bash)
  postSimpleTweet({ sourceFile: 'sprint_tweet.txt', gap: 0 });

  // Moltbook sprint update
  runScript('moltbook.js', '--sprint-update');
}

/**
 * 5. Housekeeping: trim digest + rotate logs + git commit + Vercel deploy
 * Bash: lines 936-968
 *
 * Log rotation uses in-place overwrite (read → write to same path) to preserve
 * inodes — critical because the running shell holds fd open on runner.log.
 */
function housekeeping({ today, vercelDeployHook }) {
  // Trim feed_digest.txt to 3000 lines
  trimFile(config.FEED_DIGEST_PATH, config.DIGEST_MAX_LINES);

  // Rotate logs (inode-preserving)
  rotateLog(config.RUNNER_LOG_PATH, config.RUNNER_LOG_MAX_LINES);
  rotateLog(
    path.join(config.PROJECT_ROOT, 'scraper', 'scraper.log'),
    config.SCRAPER_LOG_MAX_LINES
  );

  // Git commit daily outputs
  commitAndPush({
    paths: ['journals/', 'checkpoints/', 'state/', 'articles/', 'daily/', 'ponders/'],
    message: `daily: ${today}`,
  });

  // Vercel deploy
  triggerVercelDeploy(vercelDeployHook);
}

// ── File maintenance helpers ─────────────────────────────────────────────────

/**
 * Trim a file to maxLines using tail + mv (matches bash pattern for digest).
 */
function trimFile(fp, maxLines) {
  if (!exists(fp)) return;
  try {
    const lineCount = parseInt(
      execSync(`wc -l < "${fp}"`, { encoding: 'utf-8' }).trim(), 10
    ) || 0;
    if (lineCount > maxLines) {
      execSync(`tail -n ${maxLines} "${fp}" > /tmp/hunter_trim_tmp && mv /tmp/hunter_trim_tmp "${fp}"`, {
        stdio: 'ignore',
      });
      log(`trimmed ${path.basename(fp)}: ${lineCount} → ${maxLines} lines`);
    }
  } catch {}
}

/**
 * Rotate a log file in-place to preserve inode.
 * Bash: tail → tmp, cat tmp > file (overwrites in-place), rm tmp
 */
function rotateLog(fp, maxLines) {
  if (!exists(fp)) return;
  try {
    const lineCount = parseInt(
      execSync(`wc -l < "${fp}"`, { encoding: 'utf-8' }).trim(), 10
    ) || 0;
    if (lineCount > maxLines) {
      const tmpPath = `${fp}.tmp`;
      execSync(`tail -n ${maxLines} "${fp}" > "${tmpPath}"`, { stdio: 'ignore' });
      // cat tmp > file preserves inode (critical for running shell + open fd)
      execSync(`cat "${tmpPath}" > "${fp}"`, { stdio: 'ignore' });
      try { fs.unlinkSync(tmpPath); } catch {}
      log(`rotated ${path.basename(fp)} to last ${maxLines} lines`);
    }
  } catch {}
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the daily maintenance block if 24h have elapsed.
 *
 * @param {Object} opts
 * @param {string} opts.today - YYYY-MM-DD
 * @param {string} [opts.vercelDeployHook] - VERCEL_DEPLOY_HOOK env value
 * @returns {boolean} true if daily block ran, false if skipped (< 24h)
 */
function runDaily({ today, vercelDeployHook }) {
  if (!shouldRun()) return false;

  reports();
  checkpoint();
  ponder();
  sprint();
  housekeeping({ today, vercelDeployHook });

  markComplete();
  return true;
}

module.exports = {
  runDaily,
  // Exported for testing
  shouldRun,
  reports,
  checkpoint,
  ponder,
  sprint,
  housekeeping,
  trimFile,
  rotateLog,
};
