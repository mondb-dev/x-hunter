'use strict';

/**
 * runner/lib/pre_tweet.js — tweet cycle pre-agent pipeline
 *
 * Ported 1:1 from run.sh lines ~640-680 (inside the tweet else block,
 * before the prompt construction + agent_run).
 *
 * 3 steps:
 *   1. Archive browse_notes.md → append to browse_archive.md with cycle header
 *   2. Trim browse_archive.md to 6000 lines (tail -n 5000 on overflow)
 *   3. Browse-failed guard: if browse_notes < 80 chars OR contains failure
 *      phrases → write "SKIP" to tweet_draft.txt and return false
 *
 * Returns true if agent should run, false if skipped.
 */

const fs = require('fs');
const config = require('./config');

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

  return true;
}

module.exports = { preTweet };
