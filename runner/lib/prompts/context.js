'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read a state file with optional tail-N-lines and backtick sanitisation.
 * Backticks → apostrophes for prompt safety (matches bash sed behaviour).
 */
function readState(filePath, opts = {}) {
  const { tail, fallback = '' } = opts;
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (tail) {
      const lines = content.split('\n');
      content = lines.slice(-tail).join('\n');
    }
    return content.replace(/`/g, "'") || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Format ontology axes — compact form for browse + tweet prompts.
 *   [axis_id] label (conf:XX%, ev:N)
 *     L: left_pole (truncated 80 chars)
 *     R: right_pole (truncated 80 chars)
 */
function formatCurrentAxes() {
  try {
    const d = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf-8'));
    const axes = d.axes || [];
    if (axes.length === 0) return '  (none yet)';
    return axes.map(a => {
      const ev = (a.evidence_log || []).length;
      const conf = ((a.confidence || 0) * 100).toFixed(0);
      return '  [' + a.id + '] ' + a.label + ' (conf:' + conf + '%, ev:' + ev + ')\n' +
             '    L: ' + a.left_pole.slice(0, 80) + '\n' +
             '    R: ' + a.right_pole.slice(0, 80);
    }).join('\n');
  } catch (e) {
    return '  (could not read ontology.json: ' + e.message + ')';
  }
}

/**
 * Format top belief axes with evidence — for quote prompt.
 * Filters confidence >= 0.65, sorts desc, takes top 6.
 */
function formatTopAxes() {
  try {
    const o = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf-8'));
    const raw = Array.isArray(o.axes) ? o.axes : Object.values(o.axes || {});
    const axes = raw
      .filter(a => a.confidence >= 0.65)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);
    if (axes.length === 0) return '(unavailable)';
    return axes.map(a => {
      const ev = (a.evidence_log || []).slice(-2)
        .map(e => '    * ' + e.content.slice(0, 120)).join('\n');
      return '- ' + a.label + ' (conf: ' + (a.confidence * 100).toFixed(0) + '%)\n' +
             '  LEFT: ' + a.left_pole + '\n' +
             '  RIGHT: ' + a.right_pole +
             (ev ? '\n  Recent evidence:\n' + ev : '');
    }).join('\n\n');
  } catch {
    return '(unavailable)';
  }
}

/**
 * Build compact list of already-quoted source URLs (quote prompt dedup).
 */
function formatQuotedSources() {
  try {
    const posts = JSON.parse(fs.readFileSync(config.POSTS_LOG_PATH, 'utf-8')).posts || [];
    const quotes = posts.filter(p => p.type === 'quote' && p.source_url);
    if (quotes.length === 0) return '(none yet)';
    return quotes.map(q => '- ' + q.source_url).join('\n');
  } catch {
    return '(none yet)';
  }
}

/**
 * Load sprint context with active_plan.json fallback (tweet prompt).
 */
function loadActivePlanContext() {
  // Primary: sprint_context.txt (written by sprint_manager.js)
  try {
    const content = fs.readFileSync(config.SPRINT_CONTEXT_PATH, 'utf-8');
    if (content.trim()) return content.replace(/`/g, "'");
  } catch {}

  // Fallback: active_plan.json
  try {
    const a = JSON.parse(fs.readFileSync(config.ACTIVE_PLAN_PATH, 'utf-8'));
    if (a && a.status === 'active') {
      const days = Math.floor((Date.now() - new Date(a.activated_date).getTime()) / 86400000);
      return 'ACTIVE PLAN: ' + a.title + '\n' +
             'Goal: ' + (a.first_sprint?.week_1_goal || '(none)') + '\n' +
             'Day ' + days + ' of 30';
    }
  } catch {}

  return '(no active plan)';
}

/**
 * Parse reading_url.txt → reading block for browse prompt.
 * Detects X profile deep dive vs article/content link.
 */
function buildReadingBlock() {
  const NONE = '(no reading queue item this cycle)';
  let url = '', from = '', context = '';
  try {
    const raw = fs.readFileSync(config.READING_URL_PATH, 'utf-8');
    if (!raw.trim()) return NONE;
    const m1 = raw.match(/^URL:\s*(.+)/m);
    const m2 = raw.match(/^FROM:\s*(.+)/m);
    const m3 = raw.match(/^CONTEXT:\s*(.+)/m);
    url     = (m1 ? m1[1].trim() : '').replace(/`/g, "'");
    from    = (m2 ? m2[1].trim() : '').replace(/`/g, "'");
    context = (m3 ? m3[1].trim() : '').replace(/`/g, "'");
  } catch { return NONE; }
  if (!url) return NONE;

  // Profile deep dive
  if (/^https:\/\/x\.com\/[A-Za-z0-9_]+\/?$/.test(url)) {
    const h = url.replace('https://x.com/', '').replace(/\/$/, '');
    return from + ' asked you to learn about @' + h +
      '. DEEP DIVE \u2014 this is your primary task this cycle:\n' +
      '  URL: ' + url + '\n' +
      '  Context: ' + context + '\n\n' +
      '  Do all of the following:\n' +
      '  1. Navigate to their profile. Read their pinned tweet and bio.\n' +
      '  2. Scroll their timeline \u2014 read at least 8 recent tweets. Note their main positions,\n' +
      '     recurring themes, and any tensions or contradictions.\n' +
      '  3. Check if their views connect to any of your current belief axes. Note evidence.\n' +
      "  4. Search for '@" + h + "' to see how others engage with them (optional if time allows).\n" +
      "  5. Write a dedicated section in browse_notes.md: '## Deep Dive: @" + h + "'\n" +
      '     Summarise what you learned and whether it shifted any of your beliefs.';
  }

  // Article / content URL
  return from + ' recommended a link. Navigate to it as your FIRST task:\n' +
    '  ' + url + '\n' +
    '  Context: ' + context + '\n' +
    '  Read it carefully. Note key claims, evidence quality, and any tensions with your current axes.\n' +
    "  Write findings in browse_notes.md under '## Reading: " + url + "'";
}

/**
 * Build journal task string (browse or tweet cycle).
 */
function buildJournalTask(type, today, hour, dayNumber) {
  const jPath = path.join(config.JOURNALS_DIR, today + '_' + hour + '.html');
  if (fs.existsSync(jPath)) {
    if (type === 'browse') {
      return 'journals/' + today + '_' + hour +
        '.html ALREADY EXISTS. DO NOT write or overwrite this file under any circumstances \u2014 it has been permanently archived to Arweave and cannot be changed.';
    }
    return 'journals/' + today + '_' + hour +
      '.html ALREADY EXISTS. DO NOT write or overwrite this file \u2014 it has been permanently archived to Arweave.';
  }
  if (type === 'browse') {
    return 'Write journals/' + today + '_' + hour + '.html now. This is Day ' + dayNumber + '.\n' +
      '   Brief observation log for this browse cycle \u2014 150-200 words.\n' +
      '   One or two key tensions or signals you noticed. What is new or surprising.\n' +
      '   Use standard HTML journal format (same as tweet cycle journals).\n' +
      '   In the HTML metadata use content="' + dayNumber + '" for x-hunter-day and "Day ' + dayNumber + ' \u00b7 Hour ' + hour + '" in the header.\n' +
      '   This is the public record of what you observed. Keep it honest and specific.';
  }
  // tweet
  return 'Write journals/' + today + '_' + hour + '.html (Day ' + dayNumber +
    '). Use x-hunter-day content="' + dayNumber + '" and "Day ' + dayNumber +
    ' \u00b7 Hour ' + hour + '" in the header.';
}

// ── Main loader ─────────────────────────────────────────────────────────────

/**
 * Load all context needed for a given prompt type.
 *
 * @param {Object} opts
 * @param {string} opts.type   - 'browse' | 'tweet' | 'quote' | 'first_run'
 * @param {number} opts.cycle  - current cycle number
 * @param {number} opts.dayNumber
 * @param {string} opts.today  - YYYY-MM-DD
 * @param {string} opts.now    - HH:MM
 * @param {string} opts.hour   - HH (zero-padded)
 * @returns {Object} ctx
 */
function loadContext(opts) {
  const { type, cycle, dayNumber, today, now, hour } = opts;
  const ctx = { type, cycle, dayNumber, today, now, hour };

  if (type === 'first_run') return ctx;

  if (type === 'browse') {
    ctx.browseNotes       = readState(config.BROWSE_NOTES_PATH, { tail: 80, fallback: '(empty)' });
    ctx.topicSummary      = readState(config.TOPIC_SUMMARY_PATH, { fallback: '(not yet generated)' });
    ctx.digest            = readState(config.FEED_DIGEST_PATH, { tail: 160, fallback: '(not yet generated)' });
    ctx.critique          = readState(config.CRITIQUE_PATH, { tail: 12, fallback: '' });
    ctx.curiosityDirective = readState(config.CURIOSITY_DIRECTIVE_PATH, { fallback: '' });
    ctx.commentCandidates = readState(config.COMMENT_CANDIDATES_PATH, { fallback: '' });
    ctx.discourseDigest   = readState(config.DISCOURSE_DIGEST_PATH, { fallback: '' });
    ctx.sprintContext     = readState(config.SPRINT_CONTEXT_PATH, { fallback: '(no active plan)' });
    ctx.readingBlock      = buildReadingBlock();
    ctx.currentAxes       = formatCurrentAxes();
    ctx.journalTask       = buildJournalTask('browse', today, hour, dayNumber);
    ctx.nextTweet         = (Math.floor(cycle / config.TWEET_EVERY) + 1) * config.TWEET_EVERY;
  }

  if (type === 'quote') {
    ctx.sprintContext     = readState(config.SPRINT_CONTEXT_PATH, { fallback: '(no active plan)' });
    ctx.quotedSources     = formatQuotedSources();
    ctx.digest            = readState(config.FEED_DIGEST_PATH, { tail: 120, fallback: '(not available)' });
    ctx.topAxes           = formatTopAxes();
  }

  if (type === 'tweet') {
    ctx.browseNotesFull   = readState(config.BROWSE_NOTES_PATH, { fallback: '(empty)' });
    ctx.memoryRecall      = readState(config.MEMORY_RECALL_PATH, { fallback: '(empty)' });
    ctx.discourseDigest   = readState(config.DISCOURSE_DIGEST_PATH, { fallback: '(no discourse yet)' });
    ctx.activePlanContext = loadActivePlanContext();
    ctx.currentAxes       = formatCurrentAxes();
    ctx.journalTask       = buildJournalTask('tweet', today, hour, dayNumber);
  }

  return ctx;
}

module.exports = loadContext;
module.exports.readState = readState;
module.exports.formatCurrentAxes = formatCurrentAxes;
module.exports.formatTopAxes = formatTopAxes;
module.exports.formatQuotedSources = formatQuotedSources;
module.exports.loadActivePlanContext = loadActivePlanContext;
module.exports.buildReadingBlock = buildReadingBlock;
module.exports.buildJournalTask = buildJournalTask;

// CLI: dump context as JSON for debugging
if (require.main === module) {
  const ctx = loadContext({
    type:      process.env.PROMPT_TYPE || 'browse',
    cycle:     parseInt(process.env.CYCLE || '1', 10),
    dayNumber: parseInt(process.env.DAY_NUMBER || '1', 10),
    today:     process.env.TODAY || new Date().toISOString().slice(0, 10),
    now:       process.env.NOW   || new Date().toTimeString().slice(0, 5),
    hour:      process.env.HOUR  || String(new Date().getHours()).padStart(2, '0'),
  });
  console.log(JSON.stringify(ctx, null, 2));
}
