'use strict';

// orchestrator.js — Node orchestrator (Phase 5 + Phase 6 structured logging)
//
// Replaces the bash main loop in run.sh. Invoked via exec when ORCHESTRATOR=node.
// This is a direct 1:1 port of run.sh lines 290-990 — same sequence, same scripts,
// same state files, same branching logic. No new logic, no improvements.
//
// run.sh handles pre-loop init (singleton guard, .env, gateway start, browser start,
// git config, stream, scraper, cycle vars) then exec's here via the A/B switch.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const config = require('./lib/config');
const { agentRun } = require('./lib/agent');
const {
  restartGateway, startBrowser, checkBrowser,
  waitForBrowserService, ensureBrowser,
  checkAndFixGatewayTimeout, countGatewayErrLines,
  checkGatewayPort,
} = require('./lib/browser');
const {
  resetSession, cleanStaleLocks, backupState,
  restoreIfCorrupt, chmodPostsLog,
} = require('./lib/state');
const { preBrowse } = require('./lib/pre_browse');
const { postBrowse } = require('./lib/post_browse');
const { preTweet } = require('./lib/pre_tweet');
const { postRegularTweet, postQuoteTweet } = require('./lib/post');
const { commitAndPush, triggerVercelDeploy } = require('./lib/git');
const { runDaily } = require('./lib/daily');
const notify = require('./lib/notify');

const loadContext = require('./lib/prompts/context');
const buildBrowsePrompt = require('./lib/prompts/browse');
const buildQuotePrompt = require('./lib/prompts/quote');
const buildTweetPrompt = require('./lib/prompts/tweet');
const buildFirstRunPrompt = require('./lib/prompts/first_run');

const PROJECT_ROOT = config.PROJECT_ROOT;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[orchestrator] ${msg}`);
}

function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepSec(s) {
  sleepMs(s * 1000);
}

/** Run a node script, swallowing failures. Returns stdout. */
function runScript(scriptPath, args = '') {
  try {
    return execSync(`node "${scriptPath}"${args ? ' ' + args : ''}`, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { return ''; }
}

/** Run a node script, logging stdout to runner.log. Failures swallowed. */
function runScriptLog(scriptPath, args = '', env = {}) {
  try {
    const fullEnv = { ...process.env, ...env };
    execSync(`node "${scriptPath}"${args ? ' ' + args : ''} >> "${config.RUNNER_LOG_PATH}" 2>&1`, {
      encoding: 'utf-8',
      timeout: 120_000,
      env: fullEnv,
      shell: true,
      stdio: 'ignore',
    });
  } catch {}
}

function fileExists(fp) {
  try { return fs.existsSync(fp); } catch { return false; }
}

function readFileSafe(fp) {
  try { return fs.readFileSync(fp, 'utf-8'); } catch { return ''; }
}

// ── Signal handlers (critical — bash traps don't survive exec) ──────────────

function cleanup() {
  try { fs.rmSync(config.LOCKDIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(config.PIDFILE, { force: true }); } catch {}
}

// ── Structured logging (Phase 6) ────────────────────────────────────────────
// JSON lines to runner/orchestrator.log — one entry per cycle.

/**
 * Append a JSON line to orchestrator.log. Swallows errors.
 * @param {object} entry - structured log entry
 */
function structuredLog(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(config.ORCHESTRATOR_LOG_PATH, line);
  } catch {}
}

/**
 * Mutable per-cycle metrics object. Reset at cycle start, finalized at cycle end.
 */
function newCycleMetrics() {
  return {
    agentExitCodes: [],  // exit codes from all agentRun calls this cycle
    postAttempted: false, // whether a post pipeline was run
    postSuccess: null,    // true/false/null (null = no post this cycle)
    browserRestarted: false,
    downgradedToBrowse: false,
    errors: [],           // any notable errors captured
  };
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  log('Stopping (SIGINT)...');
  try { execSync(`bash "${config.SCRAPER_DIR}/stop.sh"`, { stdio: 'ignore', timeout: 10_000 }); } catch {}
  try { execSync(`bash "${config.STREAM_DIR}/stop.sh"`, { stdio: 'ignore', timeout: 10_000 }); } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => process.emit('SIGINT'));

// ── Caffeinate (macOS only) ─────────────────────────────────────────────────

let caffeinatePid = null;
if (process.platform === 'darwin') {
  try {
    const child = spawn('caffeinate', ['-sd', '-w', String(process.pid)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    caffeinatePid = child.pid;
    log(`caffeinate started (PID=${caffeinatePid}) — Mac sleep disabled`);
  } catch {
    log('caffeinate not available — skipping');
  }
} else {
  log('caffeinate not available (Linux) — skipping');
}

// ── Compute day number ──────────────────────────────────────────────────────

function getDayNumber(today) {
  const agentStartMs = new Date(config.AGENT_START_DATE + 'T00:00:00Z').getTime();
  const todayMs = new Date(today + 'T00:00:00Z').getTime();
  return Math.floor((todayMs - agentStartMs) / 86400000) + 1;
}

// ── Count journals ──────────────────────────────────────────────────────────

function countJournals() {
  try {
    const files = fs.readdirSync(config.JOURNALS_DIR).filter(f => f.endsWith('.html'));
    return files.length;
  } catch { return 0; }
}

// ── Scraper liveness check ──────────────────────────────────────────────────

function checkScraperLiveness() {
  let needsRestart = false;
  for (const loop of ['scraper', 'reply', 'follows']) {
    const pidFile = path.join(config.SCRAPER_DIR, `${loop}.pid`);
    if (!fileExists(pidFile)) {
      log(`${loop} pid file missing — restarting scraper...`);
      needsRestart = true;
      break;
    }
    const pid = readFileSafe(pidFile).trim() || '0';
    try {
      process.kill(parseInt(pid, 10), 0); // signal 0 = existence check
    } catch {
      log(`${loop} loop dead (pid ${pid}) — restarting scraper...`);
      needsRestart = true;
      break;
    }
  }
  if (needsRestart) {
    try {
      execSync(`bash "${config.SCRAPER_DIR}/start.sh" >> "${config.RUNNER_LOG_PATH}" 2>&1`, {
        timeout: 30_000,
        shell: true,
        stdio: 'ignore',
      });
    } catch {}
  }
}

// ── Journal existence check via git porcelain ───────────────────────────────

function journalInGit(today, hour) {
  const relPath = `journals/${today}_${hour}.html`;
  try {
    const out = execSync(
      `git -C "${PROJECT_ROOT}" status --porcelain -- "${today}_${hour}.html" journals/`,
      { encoding: 'utf-8', timeout: 10_000 }
    );
    return out.includes(relPath);
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── MAIN LOOP ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

log('Node orchestrator started (Phase 5 + Phase 6 logging)');

let cycle = 0;
let totalCycles = 0;
let totalPostAttempts = 0;
let totalPostSuccesses = 0;

// Track expected wake time for post-sleep detection.
// When setTimeout fires later than expected, Mac likely woke from sleep.
let expectedWakeTs = 0;

function runOneCycle() {

  // ── Post-sleep detection ────────────────────────────────────────────────
  // If we woke up much later than expected, Mac likely slept during the wait.
  if (expectedWakeTs > 0) {
    const lateness = Math.floor((Date.now() - expectedWakeTs) / 1000);
    if (lateness > config.BROWSE_INTERVAL) {
      log(`post-sleep detected (${lateness}s late) — restarting browser...`);
      try {
        execSync('openclaw browser --browser-profile x-hunter stop', {
          stdio: 'ignore', timeout: 15_000,
        });
      } catch {}
      sleepSec(3);
      try {
        execSync('openclaw browser --browser-profile x-hunter start', {
          stdio: 'ignore', timeout: 15_000,
        });
      } catch {}
      sleepSec(10);
      log('browser restarted after sleep wake');
    }
  }

  // ── Pause sentinel ──────────────────────────────────────────────────────
  if (fileExists(config.PAUSE_FILE)) {
    log('PAUSED (runner/PAUSE exists) — sleeping 60s. Remove file to resume.');
    setTimeout(runOneCycle, 60_000);
    return;
  }

  cycle++;
  const cycleStart = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toTimeString().slice(0, 5);
  const hour = String(new Date().getHours()).padStart(2, '0');
  const dayNumber = getDayNumber(today);
  const metrics = newCycleMetrics();

  // ── Determine cycle type ────────────────────────────────────────────────
  let cycleType;
  if (cycle % config.TWEET_EVERY === 0) {
    cycleType = 'TWEET';
  } else if (cycle % config.TWEET_EVERY === config.QUOTE_OFFSET) {
    cycleType = 'QUOTE';
  } else {
    cycleType = 'BROWSE';
  }

  // Suppress TWEET and QUOTE outside active hours → downgrade to BROWSE
  if (cycleType === 'TWEET' || cycleType === 'QUOTE') {
    const hourInt = parseInt(hour, 10);
    if (hourInt < config.TWEET_START || hourInt >= config.TWEET_END) {
      log(`Post window closed (hour=${hour}), running as BROWSE instead of ${cycleType}`);
      cycleType = 'BROWSE';
      metrics.downgradedToBrowse = true;
    }
  }

  const journalCount = countJournals();
  const digestSize = (() => {
    try { return fs.statSync(config.FEED_DIGEST_PATH).size; } catch { return 0; }
  })();

  log(`── Cycle ${cycle} (${cycleType}) — ${today} ${now} (journals=${journalCount}, digest=${digestSize}b) ──`);

  // ── Heartbeat ──────────────────────────────────────────────────────────
  try {
    fs.writeFileSync(config.HEARTBEAT_PATH,
      `cycle: ${cycle} | type: ${cycleType} | ${today} ${now}\n`);
  } catch {}

  // ── Clean stale lock files ─────────────────────────────────────────────
  cleanStaleLocks();

  // ── Scraper liveness ───────────────────────────────────────────────────
  checkScraperLiveness();

  // ── Browser health (BROWSE: light check; TWEET/QUOTE: full reset) ─────
  if (cycleType === 'BROWSE') {
    if (!checkBrowser()) {
      log('browser CDP down before browse cycle — restarting gateway + browser');
      restartGateway();
      startBrowser();
      sleepSec(15);
      metrics.browserRestarted = true;
    } else if (!checkGatewayPort()) {
      log(`gateway port ${config.GATEWAY_PORT} not responding — restarting gateway`);
      restartGateway();
      sleepSec(10);
    }
  }

  // Before tweet/quote: flush tweet agent session + ensure browser healthy
  if (cycleType === 'TWEET' || cycleType === 'QUOTE') {
    resetSession('x-hunter-tweet');
  }
  if (cycleType === 'TWEET' || cycleType === 'QUOTE') {
    ensureBrowser();
  }

  // ── Periodic restart (every 6 cycles = ~3h) ───────────────────────────
  if (cycle % 6 === 0) {
    resetSession('x-hunter');
    restartGateway();
    startBrowser();
    if (waitForBrowserService(30)) {
      log('browser healthy after reset');
    } else {
      log('WARNING: browser not ready after reset — downgrading TWEET/QUOTE to BROWSE');
      if (cycleType === 'TWEET' || cycleType === 'QUOTE') {
        cycleType = 'BROWSE';
        metrics.downgradedToBrowse = true;
      }
    }
    log(`x-hunter session + gateway restarted (context flush cycle ${cycle})`);
  }

  // Second lock sweep after gateway/browser restarts
  cleanStaleLocks();

  // ── First-ever cycle: intro tweet + profile setup ─────────────────────
  if (journalCount === 0) {
    const ctx = loadContext({
      type: 'first_run', cycle: 1, dayNumber, today, now, hour,
    });
    const prompt = buildFirstRunPrompt(ctx);
    const gwBefore = countGatewayErrLines();
    const exitCode = agentRun({ agent: 'x-hunter', message: prompt, thinking: 'high', verbose: 'on' });
    metrics.agentExitCodes.push(exitCode);
    checkAndFixGatewayTimeout(gwBefore);

  // ── BROWSE cycle ──────────────────────────────────────────────────────
  } else if (cycleType === 'BROWSE') {
    // Pre-browse: 11 scripts (FTS5 heal, query, recall, curiosity, etc.)
    preBrowse(cycle);

    // Build prompt
    const ctx = loadContext({
      type: 'browse', cycle, dayNumber, today, now, hour,
    });
    const prompt = buildBrowsePrompt(ctx);

    // Agent run with journal-missing retry
    const journalPath = path.join(config.JOURNALS_DIR, `${today}_${hour}.html`);
    const gwBefore = countGatewayErrLines();
    const journalBefore = journalInGit(today, hour);

    const browseExit = agentRun({ agent: 'x-hunter', message: prompt, thinking: 'low', verbose: 'on' });
    metrics.agentExitCodes.push(browseExit);
    checkAndFixGatewayTimeout(gwBefore);

    // Retry if journal missing
    const journalAfter = journalInGit(today, hour);
    if (!journalAfter && !journalBefore && !fileExists(journalPath)) {
      log('browse journal missing after agent run — retrying once (no thinking)');
      sleepSec(5);
      const gwBefore2 = countGatewayErrLines();
      const retryExit = agentRun({ agent: 'x-hunter', message: prompt, verbose: 'on' });
      metrics.agentExitCodes.push(retryExit);
      checkAndFixGatewayTimeout(gwBefore2);
    }

    // Post-browse: cleanup_tabs, reading_queue --mark-done, ontology delta,
    //   drift, journal commit/push, moltbook, checkpoint retry, reply
    postBrowse({ cycle, today, hour });

  // ── QUOTE cycle ───────────────────────────────────────────────────────
  } else if (cycleType === 'QUOTE') {
    const ctx = loadContext({
      type: 'quote', cycle, dayNumber, today, now, hour,
    });
    const prompt = buildQuotePrompt(ctx);

    // Snapshot + protect state
    backupState();
    chmodPostsLog('444');

    // Clear stale drafts
    try { fs.unlinkSync(config.QUOTE_DRAFT_PATH); } catch {}
    try { fs.unlinkSync(path.join(config.STATE_DIR, 'quote_result.txt')); } catch {}

    const quoteExit = agentRun({ agent: 'x-hunter', message: prompt, thinking: 'low', verbose: 'on' });
    metrics.agentExitCodes.push(quoteExit);

    // Restore state
    chmodPostsLog('644');
    restoreIfCorrupt();

    // Post-quote pipeline: cleanup_tabs → voice_filter --quote → 3s sleep →
    //   post_quote → watchdog QUOTE → critique --quote
    runScriptLog(path.join(PROJECT_ROOT, 'runner/cleanup_tabs.js'));
    const quoteResult = postQuoteTweet();
    metrics.postAttempted = true;
    metrics.postSuccess = quoteResult.posted;

    // Watchdog: verify quote was posted
    runScriptLog(path.join(PROJECT_ROOT, 'runner/watchdog.js'), '', {
      CYCLE_TYPE: 'QUOTE',
    });

    // Coherence critique
    runScriptLog(path.join(PROJECT_ROOT, 'runner/critique.js'),
      `--quote --cycle "${cycle}"`);

  // ── TWEET cycle ───────────────────────────────────────────────────────
  } else if (cycleType === 'TWEET') {
    // Pre-tweet: archive browse_notes → browse-failed guard
    const shouldRun = preTweet({ cycle, today, now });

    if (shouldRun) {
      // Snapshot + protect state
      backupState();
      chmodPostsLog('444');

      const ctx = loadContext({
        type: 'tweet', cycle, dayNumber, today, now, hour,
      });
      const prompt = buildTweetPrompt(ctx);

      // Clear stale drafts
      try { fs.unlinkSync(config.TWEET_DRAFT_PATH); } catch {}
      try { fs.unlinkSync(path.join(config.STATE_DIR, 'tweet_result.txt')); } catch {}

      const tweetExit = agentRun({ agent: 'x-hunter-tweet', message: prompt, thinking: 'low', verbose: 'on' });
      metrics.agentExitCodes.push(tweetExit);

      // Retry if tweet_draft.txt missing
      if (!fileExists(config.TWEET_DRAFT_PATH)) {
        log('tweet_draft.txt missing after agent run — retrying once (no thinking)');
        sleepSec(5);
        const retryExit = agentRun({ agent: 'x-hunter-tweet', message: prompt, verbose: 'on' });
        metrics.agentExitCodes.push(retryExit);
      }
    }

    // Close excess tabs (always, even if skipped)
    runScriptLog(path.join(PROJECT_ROOT, 'runner/cleanup_tabs.js'));

    // Restore write permission + validate state
    chmodPostsLog('644');
    restoreIfCorrupt();

    // Merge ontology delta
    runScript(path.join(PROJECT_ROOT, 'runner/apply_ontology_delta.js'));

    // Detect drift
    runScriptLog(path.join(PROJECT_ROOT, 'runner/detect_drift.js'));

    // Post regular tweet (journal URL fix → critique gate → voice filter → post)
    const tweetResult = postRegularTweet({ today, hour });
    metrics.postAttempted = true;
    metrics.postSuccess = tweetResult.posted;

    // Watchdog: verify tweet was posted
    runScriptLog(path.join(PROJECT_ROOT, 'runner/watchdog.js'), '', {
      CYCLE_TYPE: 'TWEET',
    });

    // Git commit + push
    commitAndPush({
      paths: ['journals/', 'checkpoints/', 'state/', 'articles/', 'daily/', 'ponders/'],
      message: `cycle ${cycle}: ${today} ${now}`,
    });

    // Vercel deploy
    const vercelHook = process.env.VERCEL_DEPLOY_HOOK || '';
    if (vercelHook) {
      triggerVercelDeploy(vercelHook);
    }

    // Archive journals/checkpoints
    runScriptLog(path.join(PROJECT_ROOT, 'runner/archive.js'));

    // Watchdog: verify journal
    runScriptLog(path.join(PROJECT_ROOT, 'runner/watchdog.js'), '', {
      CYCLE_TYPE: 'JOURNAL',
    });

    // Clear browse_notes.md (agent write tool rejects empty string)
    try { fs.writeFileSync(config.BROWSE_NOTES_PATH, ''); } catch {}
    log('browse_notes.md cleared');

    // Coherence critique
    runScriptLog(path.join(PROJECT_ROOT, 'runner/critique.js'),
      `--cycle "${cycle}"`);
  }

  // ── Daily maintenance (self-gated, runs after ANY cycle type) ──────────
  runDaily({
    today,
    vercelDeployHook: process.env.VERCEL_DEPLOY_HOOK || '',
  });

  // ── Health check watchdog ──────────────────────────────────────────────
  runScriptLog(path.join(PROJECT_ROOT, 'runner/watchdog.js'), '', {
    CYCLE_TYPE: 'HEALTH',
  });

  // ── Wait out remainder of interval + post-sleep detection ─────────────
  const elapsed = Math.floor((Date.now() - cycleStart) / 1000);
  const wait = config.BROWSE_INTERVAL - elapsed;

  // ── Structured log (Phase 6) ──────────────────────────────────────────
  totalCycles++;
  if (metrics.postAttempted) {
    totalPostAttempts++;
    if (metrics.postSuccess) totalPostSuccesses++;
  }
  structuredLog({
    ts: new Date().toISOString(),
    cycle,
    type: cycleType,
    durationSec: elapsed,
    day: dayNumber,
    agentExitCodes: metrics.agentExitCodes,
    postAttempted: metrics.postAttempted,
    postSuccess: metrics.postSuccess,
    browserRestarted: metrics.browserRestarted,
    downgradedToBrowse: metrics.downgradedToBrowse,
    health: {
      totalCycles,
      postSuccessRate: totalPostAttempts > 0
        ? +(totalPostSuccesses / totalPostAttempts).toFixed(3)
        : null,
      totalPostAttempts,
      totalPostSuccesses,
    },
  });

  // ── Notify: check for alert conditions ──────────────────────────────────
  notify.checkCycle({
    cycle,
    type: cycleType,
    exitCodes: metrics.agentExitCodes,
    postAttempted: metrics.postAttempted,
    postSuccess: metrics.postSuccess,
    downgradedToBrowse: metrics.downgradedToBrowse,
    browserRestarted: metrics.browserRestarted,
    health: {
      totalCycles,
      postSuccessRate: totalPostAttempts > 0
        ? +(totalPostSuccesses / totalPostAttempts).toFixed(3)
        : null,
      totalPostAttempts,
      totalPostSuccesses,
    },
  });

  if (wait > 0) {
    log(`Cycle ${cycle} (${cycleType}) done in ${elapsed}s. Next cycle in ${wait}s...`);
    expectedWakeTs = Date.now() + wait * 1000;
    setTimeout(runOneCycle, wait * 1000);
  } else {
    log(`Cycle ${cycle} (${cycleType}) done in ${elapsed}s. Starting next cycle immediately.`);

    // Cycle itself took > 2× interval — Mac likely slept during cycle work
    if (elapsed > config.BROWSE_INTERVAL * 2) {
      log(`post-sleep detected during cycle (elapsed=${elapsed}s) — restarting browser...`);
      try {
        execSync('openclaw browser --browser-profile x-hunter stop', {
          stdio: 'ignore', timeout: 15_000,
        });
      } catch {}
      sleepSec(3);
      try {
        execSync('openclaw browser --browser-profile x-hunter start', {
          stdio: 'ignore', timeout: 15_000,
        });
      } catch {}
      sleepSec(10);
      log('browser restarted after sleep wake');
    }

    expectedWakeTs = 0;
    setImmediate(runOneCycle);
  }
}

// Kick off the first cycle
runOneCycle();
