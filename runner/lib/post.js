'use strict';

/**
 * runner/lib/post.js — four distinct posting pipelines
 *
 * Ported 1:1 from run.sh. These are NOT a common function with a type flag —
 * each pipeline has genuinely different pre-processing, retry, and filter logic.
 *
 * | Flow            | Critique? | Voice filter? | Retry?      | Gap?  |
 * |-----------------|-----------|---------------|-------------|-------|
 * | Regular tweet   | Yes       | Yes           | Agent only  | No    |
 * | Quote tweet     | No        | Yes (--quote) | No          | 3s    |
 * | Link tweet      | No        | No            | 2-attempt   | 60s   |
 * | Simple tweet    | No        | No            | No          | Varies|
 *
 * All functions are synchronous to match bash behavior.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ── Shared helpers ───────────────────────────────────────────────────────────

const DRAFT_PATH = config.TWEET_DRAFT_PATH;

function log(msg) {
  console.log(`[post] ${msg}`);
}

function exists(fp) {
  try { return fs.existsSync(fp); } catch { return false; }
}

function readFile(fp) {
  try { return fs.readFileSync(fp, 'utf-8'); } catch { return ''; }
}

function readLines(fp) {
  return readFile(fp).split('\n');
}

function firstLine(fp) {
  return readLines(fp)[0] || '';
}

/**
 * Run a runner/*.js script, capture stdout (stderr piped to parent).
 * Returns stdout string. Throws on non-zero exit.
 */
function runNode(script, args = '') {
  const sp = path.join(config.RUNNER_DIR, script);
  const cmd = args ? `node "${sp}" ${args}` : `node "${sp}"`;
  return execSync(cmd, { encoding: 'utf-8', timeout: 300000 }).trim();
}

/**
 * Run a runner/*.js script, suppress all errors.
 * Returns stdout string or '' on failure.
 */
function runNodeSafe(script, args = '') {
  try { return runNode(script, args); } catch { return ''; }
}

function sleepSec(n) {
  if (n > 0) execSync(`sleep ${n}`, { stdio: 'ignore' });
}

// ── postRegularTweet ─────────────────────────────────────────────────────────
/**
 * Tweet cycle posting pipeline.
 * Bash: run.sh lines 728-793
 *
 * Steps:
 *   1. Auto-append journal URL if agent forgot it on line 2
 *   2. Critique gate (critique_tweet.js → REJECT removes draft)
 *   3. Voice filter (voice_filter.js adjusts tone based on belief stance)
 *   4. Post via CDP (post_tweet.js)
 *
 * @param {Object} opts
 * @param {string} opts.today  - YYYY-MM-DD
 * @param {string} opts.hour   - zero-padded hour (e.g. '14')
 * @returns {{ posted: boolean, rejected: boolean, skipped: boolean, tweetUrl: string|null }}
 */
function postRegularTweet({ today, hour }) {
  // ── 1. Journal URL fix ──────────────────────────────────────────────────
  if (exists(DRAFT_PATH)) {
    const lines = readLines(DRAFT_PATH);
    const line1 = (lines[0] || '').trim();
    const line2 = (lines[1] || '').trim();
    const expectedUrl = `https://sebastianhunter.fun/journal/${today}/${hour}`;
    if (line1 && line1 !== 'SKIP') {
      if (!line2 || !line2.startsWith('https://')) {
        log('tweet_draft.txt missing journal URL on line 2 — auto-appending');
        fs.writeFileSync(DRAFT_PATH, `${line1}\n${expectedUrl}\n`);
      }
    }
  }

  // ── 2. Critique gate ───────────────────────────────────────────────────
  if (exists(DRAFT_PATH)) {
    const line1 = firstLine(DRAFT_PATH);
    if (line1 && line1 !== 'SKIP') {
      const critique = runNodeSafe('critique_tweet.js');
      log(`tweet critique: ${critique}`);
      if (critique.startsWith('REJECT')) {
        log('Tweet rejected by critique gate — skipping post this cycle');
        try { fs.unlinkSync(DRAFT_PATH); } catch {}
        return { posted: false, rejected: true, skipped: false, tweetUrl: null };
      }
    }
  }

  // ── 3. Voice filter ────────────────────────────────────────────────────
  if (exists(DRAFT_PATH)) {
    const line1 = firstLine(DRAFT_PATH);
    if (line1 && line1 !== 'SKIP') {
      const vfOut = runNodeSafe('voice_filter.js');
      log(`voice filter: ${vfOut}`);
    }
  }

  // ── 4. Post tweet via CDP ──────────────────────────────────────────────
  if (exists(DRAFT_PATH)) {
    const draft = readFile(DRAFT_PATH).trim();
    if (draft === 'SKIP') {
      log('Agent chose to skip tweet this cycle (self-check failed)');
      return { posted: false, rejected: false, skipped: true, tweetUrl: null };
    }

    log('Posting tweet via CDP...');
    runNodeSafe('post_tweet.js');

    // Read result (posts_log.json is written by post_tweet.js directly)
    const resultPath = path.join(config.STATE_DIR, 'tweet_result.txt');
    const tweetUrl = readFile(resultPath).trim();
    if (tweetUrl && tweetUrl !== 'posted') {
      log(`Tweet posted: ${tweetUrl}`);
    } else {
      log('Tweet posted (URL not captured or post_tweet.js failed)');
    }
    return { posted: true, rejected: false, skipped: false, tweetUrl: tweetUrl || null };
  }

  log('No tweet_draft.txt — agent did not produce a draft');
  return { posted: false, rejected: false, skipped: false, tweetUrl: null };
}

// ── postQuoteTweet ───────────────────────────────────────────────────────────
/**
 * Quote-tweet posting pipeline.
 * Bash: run.sh lines 607-628
 *
 * Steps:
 *   1. Voice filter --quote (adjust tone for quote-tweet)
 *   2. 3s sleep (let openclaw gateway release browser WS before CDP connect)
 *   3. Post via CDP (post_quote.js)
 *
 * @returns {{ posted: boolean, quoteUrl: string|null }}
 */
function postQuoteTweet() {
  const quoteDraftPath = config.QUOTE_DRAFT_PATH;

  // ── 1. Voice filter (--quote) ──────────────────────────────────────────
  if (exists(quoteDraftPath)) {
    const qvfOut = runNodeSafe('voice_filter.js', '--quote');
    log(`voice filter (quote): ${qvfOut}`);
  }

  // ── 2. Post quote-tweet via CDP ────────────────────────────────────────
  if (exists(quoteDraftPath)) {
    log('Posting quote-tweet via CDP...');
    sleepSec(3); // give gateway time to release browser WS
    runNodeSafe('post_quote.js');

    const resultPath = path.join(config.STATE_DIR, 'quote_result.txt');
    const quoteUrl = readFile(resultPath).trim();
    if (quoteUrl && quoteUrl !== 'posted') {
      log(`Quote posted: ${quoteUrl}`);
    }
    return { posted: true, quoteUrl: quoteUrl || null };
  }

  log('No quote_draft.txt — agent did not produce a quote');
  return { posted: false, quoteUrl: null };
}

// ── postLinkTweet ────────────────────────────────────────────────────────────
/**
 * Article/link tweet with 2-attempt retry.
 * Bash: run.sh lines 835-858
 *
 * Steps:
 *   1. Read result file (line 1: URL, line 2: title)
 *   2. Truncate title to fit 280 chars
 *   3. 2-attempt loop: post_tweet.js, on fail → 20s wait + ensure_browser → retry
 *   4. On success: remove result file
 *   5. Sleep 60s rate-limit gap (always, even on failure)
 *
 * @param {Object} opts
 * @param {string} opts.resultFile - filename in state/ (e.g. 'article_result.txt')
 * @param {number} [opts.maxTitleChars=255] - max chars for title+URL budget
 * @returns {{ posted: boolean }}
 */
function postLinkTweet({ resultFile, maxTitleChars = 255 }) {
  const resultPath = path.join(config.STATE_DIR, resultFile);
  if (!exists(resultPath)) return { posted: false };

  const lines = readLines(resultPath);
  const url = (lines[0] || '').trim();
  let title = (lines[1] || '').trim();

  // Truncate title to fit within 280 chars
  const maxTitle = maxTitleChars - url.length;
  if (title.length > maxTitle) {
    title = title.substring(0, maxTitle) + '...';
  }

  fs.writeFileSync(DRAFT_PATH, `${title}\n${url}`);
  log(`tweeting link: ${url}`);

  // Lazy require to avoid circular dependency (browser.js doesn't depend on post.js)
  const { ensureBrowser } = require('./browser');

  let posted = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      runNode('post_tweet.js');
      try { fs.unlinkSync(resultPath); } catch {}
      posted = true;
      break;
    } catch (e) {
      log(`link tweet attempt ${attempt} failed (rc=${e.status || 1})`);
      if (attempt < 2) {
        log('waiting 20s before retry...');
        sleepSec(20);
        ensureBrowser();
      }
    }
  }

  if (!posted) {
    log(`link tweet failed after 2 attempts — keeping ${resultFile} for retry`);
  }

  sleepSec(60); // rate-limit gap before next tweet (always)
  return { posted };
}

// ── postSimpleTweet ──────────────────────────────────────────────────────────
/**
 * Single-attempt tweet with no filters (plan/ponder/checkpoint/sprint).
 * Bash: run.sh lines 873-921 (various instances)
 *
 * Two modes:
 *   resultFile: read URL+title → format draft → post → remove result on success
 *   sourceFile: copy to tweet_draft.txt → post → remove source always
 *
 * @param {Object} opts
 * @param {string} [opts.resultFile] - filename in state/ with URL on line 1, title on line 2
 * @param {string} [opts.sourceFile] - filename in state/ to copy directly to tweet_draft.txt
 * @param {number} [opts.maxTitleChars=240] - max chars for title+URL budget (resultFile mode)
 * @param {number} [opts.gap=0] - seconds to sleep after posting (rate-limit gap)
 * @returns {{ posted: boolean }}
 */
function postSimpleTweet({ resultFile, sourceFile, maxTitleChars = 240, gap = 0 }) {
  // ── Result file mode (checkpoint) ──────────────────────────────────────
  if (resultFile) {
    const resultPath = path.join(config.STATE_DIR, resultFile);
    if (!exists(resultPath)) return { posted: false };

    const lines = readLines(resultPath);
    const url = (lines[0] || '').trim();
    let title = (lines[1] || '').trim();

    const maxTitle = maxTitleChars - url.length;
    if (title.length > maxTitle) {
      title = title.substring(0, maxTitle) + '...';
    }

    fs.writeFileSync(DRAFT_PATH, `${title}\n${url}`);
    log(`tweeting: ${url}`);

    let rc = 1;
    try {
      runNode('post_tweet.js');
      rc = 0;
    } catch (e) {
      rc = e.status || 1;
    }

    if (rc === 0) {
      try { fs.unlinkSync(resultPath); } catch {}
      log('tweet posted');
    } else {
      log(`tweet failed (rc=${rc}) — keeping ${resultFile} for retry`);
    }

    if (gap > 0) sleepSec(gap);
    return { posted: rc === 0 };
  }

  // ── Source file mode (plan/ponder/sprint) ──────────────────────────────
  if (sourceFile) {
    const sourcePath = path.join(config.STATE_DIR, sourceFile);
    if (!exists(sourcePath)) return { posted: false };

    try { fs.copyFileSync(sourcePath, DRAFT_PATH); } catch { return { posted: false }; }
    log(`tweeting from ${sourceFile}`);

    runNodeSafe('post_tweet.js');
    try { fs.unlinkSync(sourcePath); } catch {}
    log('tweet posted');

    if (gap > 0) sleepSec(gap);
    return { posted: true };
  }

  return { posted: false };
}

module.exports = {
  postRegularTweet,
  postQuoteTweet,
  postLinkTweet,
  postSimpleTweet,
};
