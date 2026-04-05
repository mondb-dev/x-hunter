'use strict';

/**
 * runner/lib/notify.js — Telegram alert system for Sebastian Hunter
 *
 * Sends alerts to a Telegram chat when critical failures are detected.
 * Uses the Telegram Bot API (no dependencies — native https).
 *
 * Alert conditions (checked after every cycle):
 *   1. AGENT_DOWN:     N consecutive agent failures (exit code != 0)
 *   2. POST_FAILING:   M consecutive post failures
 *   3. BROWSER_DEAD:   Browser restart failed (downgraded to BROWSE)
 *   4. GIT_PUSH_FAIL:  Git push rejected (detected from runner.log)
 *   5. RECOVERY:       Agent recovered after being in alert state
 *
 * Cooldown: Each alert type has its own cooldown to prevent spam.
 *
 * Setup:
 *   1. Message @BotFather on Telegram → /newbot → get the token
 *   2. Message your bot, then visit:
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *      to find your chat_id
 *   3. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

/** Consecutive failures before alerting */
const AGENT_FAIL_THRESHOLD = 3;
const POST_FAIL_THRESHOLD = 3;

/** Cooldown per alert type (ms) — prevents spam */
const COOLDOWN_MS = {
  AGENT_DOWN:    60 * 60 * 1000,   // 1 hour
  POST_FAILING:  2 * 60 * 60 * 1000, // 2 hours
  BROWSER_DEAD:  60 * 60 * 1000,   // 1 hour
  GIT_PUSH_FAIL: 2 * 60 * 60 * 1000, // 2 hours
  RECOVERY:      0,                 // always send
};

// ── State ───────────────────────────────────────────────────────────────────

/** In-memory tracking (resets on orchestrator restart) */
let consecutiveAgentFails = 0;
let consecutivePostFails = 0;
let inAlertState = false;

/** Timestamp of last alert sent per type */
const lastAlertAt = {};

/** Persistent state file for surviving restarts */
const STATE_PATH = path.join(
  path.resolve(__dirname, '../..'), 'state', 'notify_state.json'
);

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    consecutiveAgentFails = data.consecutiveAgentFails || 0;
    consecutivePostFails = data.consecutivePostFails || 0;
    inAlertState = data.inAlertState || false;
    if (data.lastAlertAt) {
      Object.assign(lastAlertAt, data.lastAlertAt);
    }
  } catch {
    // First run or corrupt — start fresh
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      consecutiveAgentFails,
      consecutivePostFails,
      inAlertState,
      lastAlertAt,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

// Load on require
loadState();

// ── Telegram API ────────────────────────────────────────────────────────────

/**
 * Send a message via Telegram Bot API.
 * Non-blocking, fire-and-forget — failures are logged but never throw.
 */
function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[notify] Telegram not configured — skipping alert');
    return;
  }

  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 10000,
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.log(`[notify] Telegram API error (${res.statusCode}): ${body.slice(0, 200)}`);
      }
    });
  });

  req.on('error', (e) => {
    console.log(`[notify] Telegram request failed: ${e.message}`);
  });

  req.on('timeout', () => {
    req.destroy();
    console.log('[notify] Telegram request timed out');
  });

  req.write(payload);
  req.end();
}

// ── Cooldown check ──────────────────────────────────────────────────────────

function canAlert(type) {
  const cooldown = COOLDOWN_MS[type] || 60 * 60 * 1000;
  const last = lastAlertAt[type] || 0;
  return Date.now() - last >= cooldown;
}

function markAlerted(type) {
  lastAlertAt[type] = Date.now();
}

// ── Alert builders ──────────────────────────────────────────────────────────

function alert(type, message) {
  if (!canAlert(type)) return;
  markAlerted(type);

  const prefix = {
    AGENT_DOWN:    '🔴 AGENT DOWN',
    POST_FAILING:  '🟠 POSTS FAILING',
    BROWSER_DEAD:  '🟡 BROWSER DEAD',
    GIT_PUSH_FAIL: '🟡 GIT PUSH FAILED',
    RECOVERY:      '🟢 RECOVERED',
  }[type] || '⚪ ALERT';

  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const text = `<b>${prefix}</b>\n${message}\n\n<i>${ts}</i>`;

  console.log(`[notify] Sending ${type} alert`);
  sendTelegram(text);
  saveState();
}

// ── Public: called after every cycle ────────────────────────────────────────

/**
 * checkCycle(metrics) — evaluate cycle results and fire alerts if needed.
 *
 * @param {object} opts
 * @param {number}   opts.cycle       - cycle number
 * @param {string}   opts.type        - 'BROWSE' | 'TWEET' | 'QUOTE'
 * @param {number[]} opts.exitCodes   - agentExitCodes from this cycle
 * @param {boolean}  opts.postAttempted
 * @param {boolean|null} opts.postSuccess
 * @param {boolean}  opts.downgradedToBrowse
 * @param {boolean}  opts.browserRestarted
 * @param {object}   opts.health      - { totalCycles, postSuccessRate, ... }
 */
function checkCycle(opts) {
  const {
    cycle, type, exitCodes = [], postAttempted, postSuccess,
    downgradedToBrowse, browserRestarted, health = {},
  } = opts;

  // ── Agent failure tracking ──────────────────────────────────────────────
  const agentFailed = exitCodes.length > 0 && exitCodes.every(c => c !== 0);

  if (agentFailed) {
    consecutiveAgentFails++;

    if (consecutiveAgentFails >= AGENT_FAIL_THRESHOLD) {
      inAlertState = true;
      alert('AGENT_DOWN',
        `Agent has failed <b>${consecutiveAgentFails}</b> consecutive cycles.\n` +
        `Cycle: ${cycle} | Type: ${type}\n` +
        `Exit codes: [${exitCodes.join(', ')}]\n` +
        `Last success rate: ${health.postSuccessRate ?? 'N/A'}`
      );
    }
  } else if (exitCodes.length > 0) {
    // Agent ran and succeeded
    if (inAlertState) {
      alert('RECOVERY',
        `Agent recovered after <b>${consecutiveAgentFails}</b> failed cycles.\n` +
        `Cycle: ${cycle} | Type: ${type}\n` +
        `Exit codes: [${exitCodes.join(', ')}]`
      );
      inAlertState = false;
    }
    consecutiveAgentFails = 0;
  }

  // ── Post failure tracking ───────────────────────────────────────────────
  if (postAttempted) {
    if (postSuccess) {
      consecutivePostFails = 0;
    } else {
      consecutivePostFails++;
      if (consecutivePostFails >= POST_FAIL_THRESHOLD) {
        alert('POST_FAILING',
          `Post has failed <b>${consecutivePostFails}</b> consecutive attempts.\n` +
          `Cycle: ${cycle} | Type: ${type}\n` +
          `Overall success rate: ${health.postSuccessRate ?? 'N/A'}\n` +
          `(${health.totalPostSuccesses}/${health.totalPostAttempts} posts)`
        );
      }
    }
  }

  // ── Browser failure ─────────────────────────────────────────────────────
  if (downgradedToBrowse && (type === 'TWEET' || type === 'QUOTE')) {
    // This means a tweet/quote was lost because browser died
    alert('BROWSER_DEAD',
      `${type} cycle downgraded to BROWSE — browser not ready.\n` +
      `Cycle: ${cycle}\n` +
      `Browser was restarted: ${browserRestarted}`
    );
  }

  saveState();
}

/**
 * checkGitPush(success) — call after git push attempts.
 * @param {boolean} success
 * @param {string} [detail] - error message if failed
 */
function checkGitPush(success, detail) {
  if (!success) {
    alert('GIT_PUSH_FAIL',
      `Git push to origin/main failed.\n` +
      (detail ? `Error: ${detail.slice(0, 200)}` : '')
    );
  }
}

/**
 * sendTest() — send a test notification to verify setup.
 */
function sendTest() {
  sendTelegram(
    '<b>🧪 TEST</b>\nSebastian Hunter notification system is working.\n\n' +
    `<i>${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</i>`
  );
}

// ── Human request ────────────────────────────────────────────────────────────

const HUMAN_REQUEST_PATH = path.join(
  path.resolve(__dirname, '../..'), 'state', 'human_request.json'
);
const HUMAN_REQUEST_LOG_PATH = path.join(
  path.resolve(__dirname, '../..'), 'state', 'human_request_log.json'
);

/** Cooldown: agent can only ping once per 4 hours per action_needed type */
const HUMAN_REQUEST_COOLDOWN_MS = 4 * 60 * 60 * 1000;

let lastHumanRequestAt = {};

/**
 * checkHumanRequest() — called after each cycle.
 * If state/human_request.json exists, sends a Telegram message to the operator
 * describing what Sebastian needs, then removes the request file.
 *
 * Request file format:
 *   {
 *     "message":      "what Sebastian needs and why",
 *     "action_needed": "website" | "community" | "account" | "other",
 *     "priority":     "low" | "medium" | "high",   (optional, default "medium")
 *     "sprint_task":  "task title for context"     (optional)
 *   }
 */
function checkHumanRequest() {
  let req;
  try {
    req = JSON.parse(fs.readFileSync(HUMAN_REQUEST_PATH, 'utf-8'));
  } catch {
    return; // no request file
  }

  // Always consume the file to prevent re-firing next cycle
  try { fs.unlinkSync(HUMAN_REQUEST_PATH); } catch {}

  const action = (req.action_needed || 'other').toLowerCase();
  const now = Date.now();

  // Cooldown per action type
  if (lastHumanRequestAt[action] && now - lastHumanRequestAt[action] < HUMAN_REQUEST_COOLDOWN_MS) {
    console.log(`[notify] human_request cooldown active for "${action}" — skipping`);
    return;
  }
  lastHumanRequestAt[action] = now;

  const priority = req.priority || 'medium';
  const priorityIcon = priority === 'high' ? '🔴' : priority === 'low' ? '🔵' : '🟡';
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

  const lines = [
    `<b>${priorityIcon} Sebastian needs your help</b>`,
    `<b>Action needed:</b> ${req.action_needed || 'unspecified'}`,
  ];
  if (req.sprint_task) lines.push(`<b>Sprint task:</b> ${req.sprint_task}`);
  lines.push('');
  lines.push(req.message || '(no message)');
  lines.push('');
  lines.push(`<i>${ts}</i>`);

  console.log(`[notify] sending human_request alert: action="${action}" priority="${priority}"`);
  sendTelegram(lines.join('\n'));

  // Append to log (non-fatal)
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(HUMAN_REQUEST_LOG_PATH, 'utf-8')); } catch {}
    log.push({ ...req, sent_at: new Date().toISOString() });
    fs.writeFileSync(HUMAN_REQUEST_LOG_PATH, JSON.stringify(log.slice(-50), null, 2));
  } catch {}
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  checkCycle,
  checkGitPush,
  checkHumanRequest,
  sendTest,
  sendTelegram,
};
