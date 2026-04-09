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
const { clearFile, isConfirmedStatusUrl } = require('../post_result');
const { isXSuppressed, suppressionReason } = require('./x_control');

// ── Shared helpers ───────────────────────────────────────────────────────────

const DRAFT_PATH = config.TWEET_DRAFT_PATH;

function log(msg) {
  console.log(`[post] ${msg}`);
}

function exists(fp) {
  try { return fs.existsSync(fp); } catch { return false; }
}

/**
 * Check if content was already posted within the last `windowMs`.
 * Compares the first 80 chars of content against recent posts.
 * Returns true if duplicate found (should skip posting).
 */
function isDuplicatePost(content, windowMs = 2 * 60 * 60 * 1000) {
  if (!content) return false;
  try {
    const logPath = path.join(config.STATE_DIR, 'posts_log.json');
    const raw = fs.readFileSync(logPath, 'utf-8');
    const data = JSON.parse(raw);
    const posts = Array.isArray(data) ? data : (data.posts || []);
    const cutoff = Date.now() - windowMs;
    const needle = content.substring(0, 80);
    return posts.some(p => {
      if (!p.posted_at) return false;
      const ts = new Date(p.posted_at).getTime();
      if (ts < cutoff) return false;
      const hay = (p.content || p.text || '').substring(0, 80);
      return hay === needle;
    });
  } catch {
    return false;
  }
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
function runNode(script, args = '', extraEnv = {}) {
  const sp = path.join(config.RUNNER_DIR, script);
  const cmd = args ? `node "${sp}" ${args}` : `node "${sp}"`;
  return execSync(cmd, {
    encoding: 'utf-8',
    timeout: 300000,
    env: { ...process.env, ...extraEnv },
  }).trim();
}

/**
 * Run a runner/*.js script, suppress all errors.
 * Returns stdout string or '' on failure.
 */
function runNodeSafe(script, args = '', extraEnv = {}) {
  try { return runNode(script, args, extraEnv); } catch { return ''; }
}

function runNodeDetailed(script, args = '', extraEnv = {}) {
  try {
    return { ok: true, output: runNode(script, args, extraEnv) };
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout) : '';
    const stderr = err && err.stderr ? String(err.stderr) : '';
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { ok: false, output, error: err && err.message ? err.message : 'unknown error' };
  }
}

function logScriptOutput(output) {
  if (!output) return;
  const lines = String(output).split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    console.log(line);
  }
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
 * @returns {{ attempted: boolean, posted: boolean, rejected: boolean, skipped: boolean, suppressed: boolean, suppressionReason: string|null, tweetUrl: string|null }}
 */
function postRegularTweet({ today, hour, cycle }) {
  if (isXSuppressed('tweet')) {
    log('X tweet suppression active — skipping post');
    return {
      attempted: false,
      posted: false,
      rejected: false,
      skipped: true,
      suppressed: true,
      suppressionReason: suppressionReason('tweet'),
      tweetUrl: null,
    };
  }

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
        return { attempted: false, posted: false, rejected: true, skipped: false, suppressed: true, suppressionReason: 'critique_rejected', tweetUrl: null };
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
      return { attempted: false, posted: false, rejected: false, skipped: true, suppressed: true, suppressionReason: 'self_check_skip', tweetUrl: null };
    }

    // Dedup guard: skip if same content was posted in last 2h
    const tweetContent = readFile(DRAFT_PATH).split('\n')[0].trim();
    if (isDuplicatePost(tweetContent)) {
      log('DEDUP: tweet content matches a recent post — skipping');
      try { fs.unlinkSync(DRAFT_PATH); } catch {}
      return { attempted: false, posted: false, rejected: false, skipped: true, suppressed: true, suppressionReason: 'duplicate_recent_post', tweetUrl: null };
    }

    log('Posting tweet via browser CDP...');
    let attempt = runNodeDetailed('post_tweet.js', '', { CYCLE_NUMBER: String(cycle || '') });
    if (!attempt.ok) {
      log(`browser CDP failed (${attempt.error}) — falling back to API`);
      attempt = runNodeDetailed('post_tweet_api.js', '', { CYCLE_NUMBER: String(cycle || '') });
    }
    logScriptOutput(attempt.output);

    // Read result (posts_log.json is written by post_tweet.js directly)
    const resultPath = path.join(config.STATE_DIR, 'tweet_result.txt');
    const tweetUrl = readFile(resultPath).trim();
    if (isConfirmedStatusUrl(tweetUrl)) {
      try { fs.unlinkSync(DRAFT_PATH); } catch {}
      log(`Tweet posted: ${tweetUrl}`);
      return { attempted: true, posted: true, rejected: false, skipped: false, suppressed: false, suppressionReason: null, tweetUrl };
    }

    clearFile(resultPath);
    if (attempt.ok) {
      log('Tweet post returned without a confirmed URL — leaving draft for watchdog retry');
    } else {
      log(`Tweet post failed — leaving draft for watchdog retry (${attempt.error})`);
    }
    return { attempted: true, posted: false, rejected: false, skipped: false, suppressed: false, suppressionReason: null, tweetUrl: null };
  }

  log('No tweet_draft.txt — agent did not produce a draft');
  return { attempted: false, posted: false, rejected: false, skipped: false, suppressed: true, suppressionReason: 'no_draft', tweetUrl: null };
}

// ── postQuoteTweet ───────────────────────────────────────────────────────────
/**
 * Quote-tweet posting pipeline.
 * Bash: run.sh lines 607-628
 *
 * Steps:
 *   1. Voice filter --quote (adjust tone for quote-tweet)
 *   2. 3s sleep (let agent release browser WS before CDP connect)
 *   3. Post via CDP (post_quote.js)
 *
 * @returns {{ attempted: boolean, posted: boolean, suppressed: boolean, suppressionReason: string|null, quoteUrl: string|null }}
 */
function postQuoteTweet({ cycle }) {
  const quoteDraftPath = config.QUOTE_DRAFT_PATH;

  if (isXSuppressed('quote')) {
    log('X quote suppression active — skipping post');
    return {
      attempted: false,
      posted: false,
      suppressed: true,
      suppressionReason: suppressionReason('quote'),
      quoteUrl: null,
    };
  }

  // ── 1. Voice filter (--quote) ──────────────────────────────────────────
  if (exists(quoteDraftPath)) {
    const qvfOut = runNodeSafe('voice_filter.js', '--quote');
    log(`voice filter (quote): ${qvfOut}`);
  }

  // ── 2. Post quote-tweet via CDP ────────────────────────────────────────
  if (exists(quoteDraftPath)) {
    // Dedup guard: skip if same content was posted in last 2h
    const quoteLines = readFile(quoteDraftPath).split('\n').map(l => l.trim()).filter(Boolean);
    const quoteContent = quoteLines.filter(l => !/^https:\/\//.test(l)).join(' ').trim();
    if (isDuplicatePost(quoteContent)) {
      log('DEDUP: quote content matches a recent post — skipping');
      try { fs.unlinkSync(quoteDraftPath); } catch {}
      return { attempted: false, posted: false, suppressed: true, suppressionReason: 'duplicate_recent_post', quoteUrl: null };
    }

    log('Posting quote-tweet via browser CDP...');
    let attempt = runNodeDetailed('post_quote.js', '', { CYCLE_NUMBER: String(cycle || '') });
    if (!attempt.ok) {
      log(`browser CDP failed (${attempt.error}) — falling back to API`);
      attempt = runNodeDetailed('post_quote_api.js', '', { CYCLE_NUMBER: String(cycle || '') });
    }
    logScriptOutput(attempt.output);

    const resultPath = path.join(config.STATE_DIR, 'quote_result.txt');
    const quoteUrl = readFile(resultPath).trim();
    if (isConfirmedStatusUrl(quoteUrl)) {
      try { fs.unlinkSync(quoteDraftPath); } catch {}
      log(`Quote posted: ${quoteUrl}`);
      return { attempted: true, posted: true, suppressed: false, suppressionReason: null, quoteUrl };
    }

    clearFile(resultPath);
    if (attempt.ok) {
      log('Quote post returned without a confirmed URL — leaving draft for watchdog retry');
    } else {
      log(`Quote post failed — leaving draft for watchdog retry (${attempt.error})`);
    }
    return { attempted: true, posted: false, suppressed: false, suppressionReason: null, quoteUrl: null };
  }

  log('No quote_draft.txt — agent did not produce a quote');
  return { attempted: false, posted: false, suppressed: true, suppressionReason: 'no_draft', quoteUrl: null };
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
  if (isXSuppressed('tweet')) {
    log(`X tweet suppression active — keeping ${resultFile} for later`);
    return { posted: false };
  }

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

  let posted = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      try { runNode('post_tweet.js'); } catch (browserErr) {
        log(`link tweet browser attempt ${attempt} failed — falling back to API`);
        runNode('post_tweet_api.js');
      }
      try { fs.unlinkSync(resultPath); } catch {}
      posted = true;
      break;
    } catch (e) {
      log(`link tweet attempt ${attempt} failed (rc=${e.status || 1})`);
      if (attempt < 2) {
        log('waiting 20s before retry...');
        sleepSec(20);
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
  if (isXSuppressed('tweet')) {
    log('X tweet suppression active — skipping simple tweet');
    return { posted: false };
  }

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
      try { runNode('post_tweet.js'); } catch (browserErr) {
        log(`browser CDP failed — falling back to API`);
        runNode('post_tweet_api.js');
      }
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

    const sourceResult = runNodeDetailed('post_tweet.js');
    if (!sourceResult.ok) {
      log(`browser CDP failed (${sourceResult.error}) — falling back to API`);
      runNodeSafe('post_tweet_api.js');
    }
    try { fs.unlinkSync(sourcePath); } catch {}
    log('tweet posted');

    if (gap > 0) sleepSec(gap);
    return { posted: true };
  }

  return { posted: false };
}

// ── postSignalTweet ──────────────────────────────────────────────────────────
/**
 * Signal tweet posting pipeline (cross-axis anomaly detection).
 *
 * Reads state/signal_draft.txt (written by signal_detector.js).
 * Passes through voice_filter.js for tone consistency, then posts.
 * Logs to posts_log.json as type: 'signal'.
 *
 * @param {Object} opts
 * @param {string} opts.today  - YYYY-MM-DD
 * @param {string} opts.hour   - zero-padded hour (e.g. '14')
 * @returns {{ posted: boolean }}
 */
function postSignalTweet({ today, hour }) {
  if (isXSuppressed('signal')) {
    log('X signal suppression active — keeping signal draft for later');
    return { posted: false };
  }

  const signalDraftPath = config.SIGNAL_DRAFT_PATH;
  if (!exists(signalDraftPath)) return { posted: false };

  const signalText = readFile(signalDraftPath).trim();
  if (!signalText) {
    try { fs.unlinkSync(signalDraftPath); } catch {}
    return { posted: false };
  }

  // Write to tweet_draft.txt with journal URL
  const journalUrl = `https://sebastianhunter.fun/journal/${today}/${hour}`;
  fs.writeFileSync(DRAFT_PATH, `${signalText}\n${journalUrl}\n`);

  // Voice filter (keep Sebastian's tone)
  const vfOut = runNodeSafe('voice_filter.js');
  log(`voice filter (signal): ${vfOut}`);

  // Post
  log('Posting signal tweet via browser CDP...');
  const signalResult = runNodeDetailed('post_tweet.js');
  if (!signalResult.ok) {
    log(`browser CDP failed (${signalResult.error}) — falling back to API`);
    runNodeSafe('post_tweet_api.js');
  }

  const resultPath = path.join(config.STATE_DIR, 'tweet_result.txt');
  const tweetUrl = readFile(resultPath).trim();
  if (tweetUrl) {
    log(`Signal posted: ${tweetUrl}`);
  } else {
    log('Signal posted (URL not captured)');
  }

  // Re-log as type: "signal" with metadata (post_tweet.js logged as "tweet")
  try {
    const { logSignal } = require('../posts_log');
    const signalLogPath = config.SIGNAL_LOG_PATH;
    let spike_count = 0, strength = 'moderate', axes = [];
    if (exists(signalLogPath)) {
      const lines = readFile(signalLogPath).trim().split('\n').filter(Boolean);
      if (lines.length) {
        const latest = JSON.parse(lines[lines.length - 1]);
        spike_count = latest.spike_count || 0;
        strength = latest.strength || 'moderate';
        axes = (latest.axes || []).map(a => a.id);
      }
    }
    // Read back what voice_filter produced (tweet_draft.txt has final content)
    const postedContent = exists(DRAFT_PATH) ? readFile(DRAFT_PATH).trim() : signalText;
    // Patch the logTweet entry → signal entry in posts_log.json
    const postsLogPath = path.join(config.STATE_DIR, 'posts_log.json');
    if (exists(postsLogPath)) {
      const logData = JSON.parse(readFile(postsLogPath));
      const posts = Array.isArray(logData) ? logData : (logData.posts || []);
      // Find the entry just logged by post_tweet.js (last tweet entry)
      for (let i = posts.length - 1; i >= 0; i--) {
        if (posts[i].type === 'tweet') {
          posts[i].type = 'signal';
          posts[i].spike_count = spike_count;
          posts[i].strength = strength;
          posts[i].axes = axes;
          break;
        }
      }
      const out = Array.isArray(logData) ? posts : { ...logData, posts, total_posts: posts.length };
      fs.writeFileSync(postsLogPath, JSON.stringify(out, null, 2));
      log(`[posts_log] patched entry to type: signal (${spike_count} axes, ${strength})`);
    }
  } catch (e) {
    log(`[signal] logging metadata failed: ${e.message}`);
  }

  // Cleanup signal draft
  try { fs.unlinkSync(signalDraftPath); } catch {}

  return { posted: true, tweetUrl: tweetUrl || null };
}

// ── postVerificationTweet ────────────────────────────────────────────────────
/**
 * Verification tweet posting pipeline.
 *
 * Reads state/verification_draft.txt (written by verify_claims.js).
 * Passes through voice_filter.js for tone consistency, then posts.
 * Logs to posts_log.json as type: 'verification'.
 *
 * @param {Object} opts
 * @param {string} opts.today  - YYYY-MM-DD
 * @param {string} opts.hour   - zero-padded hour (e.g. '14')
 * @returns {{ posted: boolean }}
 */
function postVerificationTweet({ today, hour }) {
  if (isXSuppressed('verification')) {
    log('X verification suppression active — keeping draft for later');
    return { posted: false };
  }

  const draftPath = config.VERIFICATION_DRAFT_PATH;
  if (!exists(draftPath)) return { posted: false };

  const verifyText = readFile(draftPath).trim();
  if (!verifyText) {
    try { fs.unlinkSync(draftPath); } catch {}
    return { posted: false };
  }

  // Write to tweet_draft.txt (the shared posting path)
  fs.writeFileSync(DRAFT_PATH, verifyText + '\n');

  // Voice filter (keep Sebastian's tone)
  const vfOut = runNodeSafe('voice_filter.js');
  log(`voice filter (verification): ${vfOut}`);

  // Post
  log('Posting verification tweet via browser CDP...');
  const postResult = runNodeDetailed('post_tweet.js');
  if (!postResult.ok) {
    log(`browser CDP failed (${postResult.error}) — falling back to API`);
    runNodeSafe('post_tweet_api.js');
  }

  const resultPath = path.join(config.STATE_DIR, 'tweet_result.txt');
  const tweetUrl = readFile(resultPath).trim();
  if (tweetUrl) {
    log(`Verification posted: ${tweetUrl}`);
  } else {
    log('Verification posted (URL not captured)');
  }

  // Patch the posts_log entry type from "tweet" to "verification"
  try {
    const postedContent = exists(DRAFT_PATH) ? readFile(DRAFT_PATH).trim() : verifyText;
    const postsLogPath = path.join(config.STATE_DIR, 'posts_log.json');
    if (exists(postsLogPath)) {
      const logData = JSON.parse(readFile(postsLogPath));
      const posts = Array.isArray(logData) ? logData : (logData.posts || []);
      for (let i = posts.length - 1; i >= 0; i--) {
        if (posts[i].type === 'tweet') {
          posts[i].type = 'verification';
          break;
        }
      }
      const out = Array.isArray(logData) ? posts : { ...logData, posts, total_posts: posts.length };
      fs.writeFileSync(postsLogPath, JSON.stringify(out, null, 2));
      log('[posts_log] patched entry to type: verification');
    }

    // Update verification DB with tweet URL
    try {
      // Extract claim_id from draft text (format: 'Claim check: "..."')
      const vdb = require('../intelligence/verification_db');
      const allVerified = vdb.getAllVerifications();
      // Find the most recently verified claim that hasn't been tweeted
      const candidate = allVerified.find(c =>
        (c.status === 'supported' || c.status === 'refuted') && !c.tweet_posted
      );
      if (candidate && tweetUrl) {
        vdb.markTweetPosted(candidate.claim_id, tweetUrl);
        log(`[verification_db] marked ${candidate.claim_id} as tweeted`);
      }
    } catch (e) {
      log(`[verification_db] tweet tracking failed: ${e.message}`);
    }
  } catch (e) {
    log(`[verification] logging metadata failed: ${e.message}`);
  }

  // Cleanup verification draft
  try { fs.unlinkSync(draftPath); } catch {}

  return { posted: true, tweetUrl: tweetUrl || null };
}

module.exports = {
  postRegularTweet,
  postQuoteTweet,
  postLinkTweet,
  postSimpleTweet,
  postSignalTweet,
  postVerificationTweet,
};
