'use strict';

/**
 * runner/lib/pre_tweet.js — tweet cycle pre-agent pipeline
 *
 * Ported 1:1 from run.sh lines ~640-680 (inside the tweet else block,
 * before the prompt construction + agent_run).
 *
 * 4 steps:
 *   1. Archive browse_notes.md → append to browse_archive.md with cycle header
 *   2. Trim browse_archive.md to 6000 lines (tail -n 5000 on overflow)
 *   3. Browse-failed guard: if browse_notes < 80 chars OR contains failure
 *      phrases → write "SKIP" to tweet_draft.txt and return false
 *   4. Memory recall: run recall.js to pre-load memory_recall.txt for grounding
 *
 * Returns true if agent should run, false if skipped.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function log(msg) {
  console.log(`[run] ${msg}`);
}

/**
 * Failure phrase patterns — same set used in post_browse.js for journal suppression
 * and here for tweet skip guard.
 *
 * Matches bash: grep -qi "browser control service\|browser.*unavailable\|
 *   no new observations\|unable to perform"
 */
const FAILURE_PATTERNS = [
  /browser control service/i,
  /browser.*unavailable/i,
  /no new observations/i,
  /unable to perform/i,
];

/**
 * preTweet({ cycle, today, now })
 *
 * @param {object} opts
 * @param {number} opts.cycle - current cycle number
 * @param {string} opts.today - YYYY-MM-DD
 * @param {string} opts.now   - HH:MM
 * @returns {boolean} true if agent should run, false if skipped (SKIP written)
 */
function preTweet({ cycle, today, now }) {
  // ── 1. Archive browse_notes.md → browse_archive.md ────────────────────
  let browseNotes = '';
  try {
    browseNotes = fs.readFileSync(config.BROWSE_NOTES_PATH, 'utf-8');
  } catch {}

  if (browseNotes.length > 0) {
    const header = `\n── ${today} ${now} · cycle ${cycle} ──────────────────────────────────────────\n`;
    try {
      fs.appendFileSync(config.BROWSE_ARCHIVE_PATH, header + browseNotes);
    } catch {}

    // ── 2. Trim browse_archive.md to 6000 lines ────────────────────────
    try {
      const archContent = fs.readFileSync(config.BROWSE_ARCHIVE_PATH, 'utf-8');
      const lines = archContent.split('\n');
      if (lines.length > config.BROWSE_ARCHIVE_MAX_LINES) {
        const trimmed = lines.slice(-5000).join('\n');
        fs.writeFileSync(config.BROWSE_ARCHIVE_PATH, trimmed);
        log('trimmed browse_archive.md to 5000 lines');
      }
    } catch {}
  }

  // ── 3. Browse-failed guard ────────────────────────────────────────────
  if (browseNotes.length < 80) {
    log('Browse notes empty or browser-failure cycle — skipping tweet (writing SKIP)');
    fs.writeFileSync(config.TWEET_DRAFT_PATH, 'SKIP\n');
    return false;
  }

  if (FAILURE_PATTERNS.some(p => p.test(browseNotes))) {
    log('Browse notes empty or browser-failure cycle — skipping tweet (writing SKIP)');
    fs.writeFileSync(config.TWEET_DRAFT_PATH, 'SKIP\n');
    return false;
  }

  // ── 4. Memory recall for grounding (AGENTS.md §18) ───────────────────
  // Extract key topics from browse notes for recall query
  try {
    const topicFile = path.join(config.STATE_DIR, 'topic_summary.txt');
    let recallQuery = '';
    try {
      recallQuery = fs.readFileSync(topicFile, 'utf-8')
        .split('\n').filter(l => l.trim()).slice(0, 3).join(' ')
        .replace(/["`$\\!;|&<>(){}]/g, '').trim();
    } catch {}

    if (!recallQuery) {
      // Fallback: extract first meaningful line from browse notes
      recallQuery = browseNotes.split('\n').find(l => l.trim().length > 20) || '';
      recallQuery = recallQuery.replace(/["`$\\!;|&<>(){}]/g, '').slice(0, 200).trim();
    }

    if (recallQuery) {
      execSync(
        `node "${path.join(PROJECT_ROOT, 'runner/recall.js')}" --query "${recallQuery}" --limit 5`,
        { stdio: 'ignore', timeout: 30_000 }
      );
      log('pre-tweet recall loaded for grounding');
    }
  } catch (e) {
    log(`pre-tweet recall failed (non-fatal): ${e.message}`);
  }

  return true;
}

module.exports = { preTweet };
