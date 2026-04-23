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
const { commitAndPush, triggerVercelDeploy, syncToGCS } = require('./git');

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
  // Verification pipeline: score + web-search unverified claims from tracker
  try {
    const verifyScript = path.join(config.RUNNER_DIR, 'intelligence', 'verify_claims.js');
    const verifyLog = path.join(config.RUNNER_DIR, 'verify_claims.log');
    execSync(`node "${verifyScript}" >> "${verifyLog}" 2>&1`, {
      shell: true, stdio: 'ignore', timeout: 600000,
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

  // Article tweet: excerpt + website link (not moltbook link)
  const articleResultPath = path.join(config.STATE_DIR, 'article_result.txt');
  if (fs.existsSync(articleResultPath)) {
    try {
      // Find today's article file for excerpt
      const articlesDir = path.join(config.PROJECT_ROOT, 'articles');
      const articleFiles = fs.readdirSync(articlesDir)
        .filter(f => f.startsWith(today) && f.endsWith('.md')).sort();
      let excerpt = '';
      let slug = '';
      if (articleFiles.length) {
        const articleContent = fs.readFileSync(path.join(articlesDir, articleFiles[0]), 'utf-8');
        slug = articleFiles[0].replace('.md', '');
        // Extract first paragraph after frontmatter
        const body = articleContent.replace(/^---[\s\S]*?---\s*/, '');
        const para = body.split('\n\n').find(p => p.trim().length > 30 && !p.startsWith('#'));
        if (para) {
          excerpt = para.trim().replace(/\n/g, ' ');
        }
      }
      const webUrl = slug
        ? `https://sebastianhunter.fun/articles/${slug}`
        : 'https://sebastianhunter.fun/articles';
      if (!excerpt) {
        // Fallback: read title from result file
        const lines = fs.readFileSync(articleResultPath, 'utf-8').split('\n');
        excerpt = (lines[1] || 'New article published').trim();
      }
      const maxExcerpt = 250 - webUrl.length - 1; // -1 for newline separator
      if (excerpt.length > maxExcerpt) {
        // Cut at last word boundary before limit, not mid-word
        const cut = excerpt.slice(0, maxExcerpt - 1).replace(/\s+\S*$/, '');
        excerpt = (cut || excerpt.slice(0, maxExcerpt - 1)) + '…';
      }

      const DRAFT_PATH = config.TWEET_DRAFT_PATH;
      fs.writeFileSync(DRAFT_PATH, `${excerpt}\n${webUrl}`);
      log(`article tweet: ${webUrl}`);

      // Post with 2-attempt retry
      let posted = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          execSync(`node "${path.join(config.RUNNER_DIR, 'post_tweet.js')}"`, { timeout: 60_000 });
          posted = true;
          break;
        } catch {
          if (attempt < 2) sleepSec(20);
        }
      }
      if (posted) {
        try { fs.unlinkSync(articleResultPath); } catch {}
        log('article tweet posted');
      } else {
        log('article tweet failed — keeping result for retry');
      }
      sleepSec(60);
    } catch (e) {
      log(`article tweet error: ${e.message}`);
    }
  }
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

  // Checkpoint tweet: gist of interpretation + website link
  // (the retry logic in post_browse.js handles the actual gist extraction;
  //  daily just ensures checkpoint_result.txt exists for next browse cycle to pick up)
  const cpResultPath = path.join(config.STATE_DIR, 'checkpoint_result.txt');
  if (fs.existsSync(cpResultPath)) {
    log('checkpoint_result.txt exists — will be tweeted in next browse cycle');
  }
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

  // Plan and ponder tweet posting disabled (not part of new cadence)
  // Ponder/plan data still generated for web pages.
  try { fs.unlinkSync(path.join(config.STATE_DIR, 'plan_tweet.txt')); } catch {}
  const ponderTweetPath = path.join(config.STATE_DIR, 'ponder_tweet.txt');
  if (exists(ponderTweetPath)) {
    try { fs.unlinkSync(ponderTweetPath); } catch {}
    // Still flag moltbook ponder post as pending (moltbook posting is fine)
    try {
      fs.writeFileSync(path.join(config.STATE_DIR, 'ponder_post_pending'), '');
    } catch {}
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
  // feed_digest.txt — time-based 72h rotation runs every 2h from post_browse.js.
  // This is a safety-net line cap in case the trim stamp gets stale.
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

  // Deploy: Vercel (legacy) + GCS sync for Cloud Run
  triggerVercelDeploy(vercelDeployHook);
  syncToGCS();
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
