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
const { agentRunSync: agentRun } = require('./lib/gemini_agent');
const {
  startBrowser, checkBrowser,
  waitForBrowserService, ensureBrowser,
} = require('./lib/browser');
const {
  cleanStaleLocks, backupState,
  restoreIfCorrupt, chmodPostsLog,
} = require('./lib/state');
const { preBrowse } = require('./lib/pre_browse');
const { postBrowse } = require('./lib/post_browse');
const { preTweet } = require('./lib/pre_tweet');
const { assess: cadenceAssess, readDirectives, consumeOverride } = require('./cadence');
const { postRegularTweet, postQuoteTweet } = require('./lib/post');
const { commitAndPush, triggerVercelDeploy, syncToGCS } = require('./lib/git');
const { runDaily } = require('./lib/daily');
const notify = require('./lib/notify');
const { isXSuppressed, suppressionReason } = require('./lib/x_control');

const loadContext = require('./lib/prompts/context');
const buildBrowsePrompt = require('./lib/prompts/browse');
const buildQuotePrompt = require('./lib/prompts/quote');
const buildTweetPrompt = require('./lib/prompts/tweet');
const buildFirstRunPrompt = require('./lib/prompts/first_run');
const { buildBuilderPrompt } = require('./lib/prompts/builder');
const { scanTools, executeToolRequest } = require('./lib/tools');

const PROJECT_ROOT = config.PROJECT_ROOT;

// ── META cycle state ────────────────────────────────────────────────────────
const META_STATE_PATH = path.join(config.STATE_DIR, 'meta_last_run.txt');
const PROPOSAL_PATH   = path.join(config.STATE_DIR, 'process_proposal.json');
const STAGING_DIR     = path.join(PROJECT_ROOT, 'staging');

function canRunMeta() {
  // 1. Proposal must exist, be pending, and not expired
  try {
    const p = JSON.parse(fs.readFileSync(PROPOSAL_PATH, 'utf-8'));
    if (p.status !== 'pending') return false;

    const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const created = p.created_at ? new Date(p.created_at).getTime() : 0;
    if (created && Date.now() - created > EXPIRY_MS) {
      p.status       = 'expired';
      p.resolved_at  = new Date().toISOString();
      p.resolution   = 'Proposal expired after 7 days without execution';
      fs.writeFileSync(PROPOSAL_PATH, JSON.stringify(p, null, 2));
      log(`META: proposal "${p.title}" expired — skipping`);
      return false;
    }
  } catch { return false; }

  // 2. Max 1 META per 24h
  try {
    const lastRun = fs.readFileSync(META_STATE_PATH, 'utf-8').trim();
    const elapsed = Date.now() - new Date(lastRun).getTime();
    if (elapsed < 24 * 60 * 60 * 1000) return false;
  } catch {} // file missing = never run → OK

  // 3. Block if HEALTH check found CRITICAL errors in the last 2h
  try {
    const health  = JSON.parse(fs.readFileSync(
      path.join(config.STATE_DIR, 'health_state.json'), 'utf-8'));
    const ageMs   = Date.now() - new Date(health.checked_at).getTime();
    if (ageMs < 2 * 60 * 60 * 1000
        && (health.last_severity === 'CRITICAL' || health.last_severity === 'ERROR')) {
      log(`META: blocked — HEALTH check found ${health.last_severity} errors in last 2h`);
      return false;
    }
  } catch {} // health_state missing = no check yet → OK

  return true;
}

/**
 * Parse builder LLM response — extract fenced code blocks with staging paths.
 * Expects format:
 *   ### staging/path/to/file.js
 *   ```javascript
 *   ...code...
 *   ```
 */
function parseBuilderResponse(response) {
  const files = [];
  // Match: ### staging/path\n```lang\ncontent\n```
  const regex = /###\s+staging\/(.+?)\s*\n```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(response)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    // Sanitize path: no .., no absolute paths
    if (filePath.includes('..') || filePath.startsWith('/')) continue;
    files.push({ filePath, content });
  }
  return files;
}

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
  // Only remove the PID file if it belongs to THIS process.
  // Prevents a rejected duplicate from deleting the running instance's PID file.
  try {
    const filePid = fs.readFileSync(config.PIDFILE, 'utf-8').trim();
    if (filePid === String(process.pid)) {
      fs.rmSync(config.PIDFILE, { force: true });
    }
  } catch {}
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
    postSuppressed: false,
    postSuppressionReason: null,
    browserRestarted: false,
    toolExecuted: false,  // whether a tool request was processed
    downgradedToBrowse: false,
    errors: [],           // any notable errors captured
  };
}

process.on('exit', cleanup);
process.on('SIGHUP', () => log('Ignoring SIGHUP'));   // nohup sets SIG_IGN but Node resets it
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
// ── SINGLETON GUARD ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

(function singletonGuard() {
  const pidFile = config.PIDFILE;
  if (fileExists(pidFile)) {
    const oldPid = readFileSafe(pidFile).trim();
    if (oldPid && Number(oldPid) !== process.pid) {
      // Skip if the PID matches our own (run.sh writes $$ then exec's into us)
      try {
        process.kill(Number(oldPid), 0); // 0 = existence check
        log(`Another orchestrator is already running (pid ${oldPid}). Exiting.`);
        process.exit(1);
      } catch {
        // process doesn't exist — stale pidfile, proceed
        log(`Removing stale pidfile (old pid ${oldPid})`);
      }
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));
  // PID file cleanup is handled by the global cleanup() function (line 95),
  // which checks process.pid before deleting. No extra exit handler needed.
})();

// ══════════════════════════════════════════════════════════════════════════════
// ── MAIN LOOP ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

log('Node orchestrator started (Phase 5 + Phase 6 logging)');

// ── Tool discovery ────────────────────────────────────────────────────────
try {
  const tools = scanTools();
  log(`tools: ${tools.length} discovered${tools.length ? ' (' + tools.map(t => t.name).join(', ') + ')' : ''}`);
} catch (e) {
  log(`tool discovery failed (non-fatal): ${e.message}`);
}

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
      startBrowser();
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

  // ── Recover stale META proposal (process crash recovery) ────────────────
  try {
    const p = JSON.parse(fs.readFileSync(PROPOSAL_PATH, 'utf-8'));
    if (p.status === 'building' || p.status === 'testing') {
      log(`recovering stale proposal "${p.title}" (status: ${p.status}) → pending`);
      p.status = 'pending';
      fs.writeFileSync(PROPOSAL_PATH, JSON.stringify(p, null, 2));
    }
  } catch {}

  // ── Determine cycle type (cadence-aware) ────────────────────────────────
  const cadence = readDirectives();
  let cycleType;

  // ── New cadence: no regular tweets. Only QUOTE (1-2/day) + BROWSE ────
  // Cadence override: Sebastian requested a specific cycle type
  if (cadence.next_cycle_type) {
    cycleType = cadence.next_cycle_type;
    log(`cadence override: ${cycleType} (consecutive: ${cadence.consecutive_overrides})`);
    consumeOverride(); // consume so it doesn't repeat
  } else if (cadence.post_eagerness === 'suppress') {
    // Suppress mode: always browse, never initiate posts
    cycleType = 'BROWSE';
  } else {
    // Default: TWEET every TWEET_EVERY cycles, QUOTE at offset, BROWSE otherwise
    if (cycle % config.TWEET_EVERY === 0) {
      cycleType = 'TWEET';
    } else if (cycle % config.TWEET_EVERY === config.QUOTE_OFFSET) {
      cycleType = 'QUOTE';
    } else {
      cycleType = 'BROWSE';
    }
  }

  if (cycleType === 'TWEET' && isXSuppressed('tweet')) {
    log(`X tweet suppression active — running BROWSE instead of TWEET`);
    cycleType = 'BROWSE';
    metrics.postSuppressed = true;
    metrics.postSuppressionReason = suppressionReason('tweet');
  } else if (cycleType === 'QUOTE' && isXSuppressed('quote')) {
    log(`X quote suppression active — running BROWSE instead of QUOTE`);
    cycleType = 'BROWSE';
    metrics.postSuppressed = true;
    metrics.postSuppressionReason = suppressionReason('quote');
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

  // ── Re-assert PID file (self-healing: something external deletes it) ──
  try { fs.writeFileSync(config.PIDFILE, String(process.pid)); } catch {}

  // ── Clean stale lock files ─────────────────────────────────────────────
  cleanStaleLocks();

  // ── Scraper liveness ───────────────────────────────────────────────────
  checkScraperLiveness();

  // ── Browser health (BROWSE: full reset every cycle; TWEET/QUOTE: below) ─
  // Clear stale cadence state before BROWSE — each cycle gets fresh context.
  if (cycleType === 'BROWSE') {

    // Clear poisoned cadence focus_note so the agent doesn't inherit a
    // stale "browser unavailable" belief from a previous failed cycle.
    try {
      const cadencePath = path.join(config.STATE_DIR, 'cadence.json');
      if (fs.existsSync(cadencePath)) {
        const cad = JSON.parse(fs.readFileSync(cadencePath, 'utf-8'));
        const fn = (cad.assessment && cad.assessment.focus_note) || '';
        if (/browser.*unavail|blocked.*browser|await.*browser/i.test(fn)) {
          cad.assessment.focus_note = 'Browser restored. Resume normal operations.';
          fs.writeFileSync(cadencePath, JSON.stringify(cad, null, 2));
          log('cleared stale "browser unavailable" cadence focus_note');
        }
      }
    } catch {}

    if (!checkBrowser()) {
      log('browser CDP down before browse cycle — restarting browser');
      startBrowser();
      sleepSec(15);
      metrics.browserRestarted = true;
    }
  }

  // Before tweet/quote: ensure browser healthy
  if (cycleType === 'TWEET' || cycleType === 'QUOTE') {
    if (!checkBrowser()) {
      startBrowser();
    }
    if (!waitForBrowserService(30)) {
      log('WARNING: browser not ready before TWEET/QUOTE -- proceeding anyway');
    }
  }

  // ── Periodic browser restart (every 6 cycles = ~3h) ──────────────────
  if (cycle % 6 === 0) {
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
    log(`browser restarted (refresh cycle ${cycle})`);
  }

  // Second lock sweep after gateway/browser restarts
  cleanStaleLocks();

  // ── First-ever cycle: intro tweet + profile setup ─────────────────────
  if (journalCount === 0) {
    const ctx = loadContext({
      type: 'first_run', cycle: 1, dayNumber, today, now, hour,
    });
    const prompt = buildFirstRunPrompt(ctx);
    const exitCode = agentRun({ agent: 'x-hunter', message: prompt, thinking: 'high', verbose: 'on' });
    metrics.agentExitCodes.push(exitCode);

  // ── META cycle (replaces BROWSE when proposal is pending) ──────────────
  } else if (cycleType === 'BROWSE' && canRunMeta()) {
    cycleType = 'META';
    log('META cycle: pending proposal detected — running builder');

    try {
      const proposal = JSON.parse(fs.readFileSync(PROPOSAL_PATH, 'utf-8'));

      // Load previous attempts from history
      let previousAttempts = [];
      try {
        const history = JSON.parse(fs.readFileSync(
          path.join(config.STATE_DIR, 'proposal_history.json'), 'utf-8'));
        previousAttempts = (history.proposals || [])
          .filter(p => p.id === proposal.id && p.status === 'failed');
      } catch {}

      // Build prompt
      const prompt = buildBuilderPrompt({ proposal, previousAttempts });

      // Mark proposal as building
      proposal.status = 'building';
      fs.writeFileSync(PROPOSAL_PATH, JSON.stringify(proposal, null, 2));

      // Call builder agent via Vertex AI (sync wrapper around async)
      log('calling builder agent (Vertex AI)...');
      let response;
      try {
        // Write prompt to temp file, call builder in subprocess
        const tmpPrompt = path.join(config.STATE_DIR, 'builder_prompt.txt');
        fs.writeFileSync(tmpPrompt, prompt);
        response = execSync(
          `node "${path.join(PROJECT_ROOT, 'runner/builder_call.js')}" "${tmpPrompt}"`,
          {
            encoding: 'utf-8',
            timeout: 300_000, // 5 min for code generation
            cwd: PROJECT_ROOT,
            maxBuffer: 10 * 1024 * 1024,
          }
        );
        try { fs.unlinkSync(tmpPrompt); } catch {}
      } catch (e) {
        const stderr = e.stderr ? e.stderr.toString().slice(0, 300) : e.message;
        throw new Error(`Builder call failed: ${stderr}`);
      }

      // Parse response — extract fenced code blocks and write to staging/
      log('parsing builder response...');
      fs.mkdirSync(STAGING_DIR, { recursive: true });

      const fileBlocks = parseBuilderResponse(response);
      if (fileBlocks.length === 0) {
        throw new Error('Builder produced no valid file blocks');
      }
      for (const { filePath: fp, content } of fileBlocks) {
        const fullPath = path.join(STAGING_DIR, fp);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        log(`staging: ${fp}`);
      }

      // Auto-generate manifest if builder omitted it
      const manifestDest = path.join(STAGING_DIR, 'manifest.json');
      if (!fs.existsSync(manifestDest)) {
        log('builder omitted manifest.json - generating synthetic manifest');
        const syntheticManifest = {
          proposal_id: proposal.id,
          files: fileBlocks
            .filter(b => b.filePath !== 'manifest.json')
            .map(b => ({
              path: b.filePath,
              action: fs.existsSync(path.join(PROJECT_ROOT, b.filePath)) ? 'modify' : 'create'
            })),
          test_commands: [],
          rollback_safe: true
        };
        fs.writeFileSync(manifestDest, JSON.stringify(syntheticManifest, null, 2));
        log('synthetic manifest: ' + syntheticManifest.files.map(f => f.path).join(', '));
      }

      // Run builder pipeline
      log('running builder pipeline...');
      proposal.status = 'testing';
      fs.writeFileSync(PROPOSAL_PATH, JSON.stringify(proposal, null, 2));

      const pipelineExit = (() => {
        try {
          execSync(`node "${path.join(PROJECT_ROOT, 'runner/builder_pipeline.js')}"`, {
            stdio: 'inherit',
            timeout: 120_000,
            cwd: PROJECT_ROOT,
          });
          return 0;
        } catch (e) {
          return e.status || 1;
        }
      })();

      if (pipelineExit === 0) {
        log('META cycle: proposal merged successfully');
      } else {
        log(`META cycle: pipeline exited with code ${pipelineExit}`);
      }

      // Record META run timestamp
      fs.writeFileSync(META_STATE_PATH, new Date().toISOString());

    } catch (e) {
      log(`META cycle failed: ${e.message}`);
      // Reset proposal to pending so it can be retried
      try {
        const proposal = JSON.parse(fs.readFileSync(PROPOSAL_PATH, 'utf-8'));
        if (proposal.status === 'building' || proposal.status === 'testing') {
          proposal.status = 'pending';
          fs.writeFileSync(PROPOSAL_PATH, JSON.stringify(proposal, null, 2));
        }
      } catch {}
      // Record META run timestamp even on failure (24h cooldown still applies)
      try { fs.writeFileSync(META_STATE_PATH, new Date().toISOString()); } catch {}
    }

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
    // Unlock journal if it was archived read-only by a prior cycle in the same hour
    if (fileExists(journalPath)) {
      try { fs.chmodSync(journalPath, 0o644); } catch {}
    }
    const journalBefore = journalInGit(today, hour);

    const browseExit = agentRun({ agent: 'x-hunter', message: prompt, thinking: 'low', verbose: 'on' });
    metrics.agentExitCodes.push(browseExit);

    // Retry if journal missing
    const journalAfter = journalInGit(today, hour);
    if (!journalAfter && !journalBefore && !fileExists(journalPath)) {
      log('browse journal missing after agent run — retrying once (no thinking)');
      sleepSec(5);
      const retryExit = agentRun({ agent: 'x-hunter', message: prompt, verbose: 'on' });
      metrics.agentExitCodes.push(retryExit);
    }

    // Post-browse: cleanup_tabs, reading_queue --mark-done, ontology delta,
    //   drift, journal commit/push, moltbook, checkpoint retry, reply
    postBrowse({ cycle, today, hour });

    // ── Periodic full commit (every 6th cycle — replaces old TWEET cycle ops) ──
    if (cycle % config.TWEET_EVERY === 0) {
      log('periodic full commit (checkpoints, articles, ponders, state)');
      commitAndPush({
        paths: ['journals/', 'checkpoints/', 'state/', 'articles/', 'daily/', 'ponders/'],
        message: `cycle ${cycle}: ${today} ${now}`,
      });
      const vercelHook = process.env.VERCEL_DEPLOY_HOOK || '';
      if (vercelHook) triggerVercelDeploy(vercelHook);
      syncToGCS();
      runScriptLog(path.join(PROJECT_ROOT, 'runner/archive.js'));
      runScriptLog(path.join(PROJECT_ROOT, 'runner/watchdog.js'), '', {
        CYCLE_TYPE: 'JOURNAL',
      });
    }

    // ── Tool execution (if Sebastian requested a tool) ────────────────────
    if (fileExists(config.TOOL_REQUEST_PATH)) {
      try {
        log('tool request detected — executing...');
        const toolResult = executeToolRequest();
        const name = toolResult.workflow ? 'workflow' : toolResult.tool;
        log(`tool "${name}" completed: ${toolResult.status}`);
        metrics.toolExecuted = true;
      } catch (e) {
        log(`tool execution failed: ${e.message}`);
      }
    }

    // ── Human request (Sebastian flagged something needing operator action) ──
    try { notify.checkHumanRequest(); } catch (e) { log(`human_request check failed: ${e.message}`); }

    // ── Cadence: self-regulated assessment after browse ──────────────────────
    try {
      cadenceAssess();
    } catch (e) {
      log(`cadence assess failed: ${e.message}`);
    }

  // ── QUOTE cycle ───────────────────────────────────────────────────────
  } else if (cycleType === 'QUOTE') {
    // Pre-load memory recall for grounding (AGENTS.md §18)
    try {
      const topicFile = path.join(config.STATE_DIR, 'topic_summary.txt');
      let recallQ = '';
      try { recallQ = fs.readFileSync(topicFile, 'utf-8').split('\n').filter(l => l.trim()).slice(0, 3).join(' ').replace(/["`$\\!;|&<>(){}]/g, '').trim(); } catch {}
      if (!recallQ) {
        try { recallQ = fs.readFileSync(config.FEED_DIGEST_PATH, 'utf-8').split('\n').find(l => l.trim().length > 20) || ''; } catch {}
        recallQ = recallQ.replace(/["`$\\!;|&<>(){}]/g, '').slice(0, 200).trim();
      }
      if (recallQ) {
        execSync(`node "${path.join(PROJECT_ROOT, 'runner/recall.js')}" --query "${recallQ}" --limit 5`, { stdio: 'ignore', timeout: 30000 });
        log('pre-quote recall loaded for grounding');
      }
    } catch (e) { log(`pre-quote recall failed (non-fatal): ${e.message}`); }

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
    try { fs.unlinkSync(path.join(config.STATE_DIR, 'quote_attempt.json')); } catch {}

    const quoteExit = agentRun({ agent: 'x-hunter', message: prompt, thinking: 'low', verbose: 'on' });
    metrics.agentExitCodes.push(quoteExit);

    // Restore state
    chmodPostsLog('644');
    restoreIfCorrupt();

    // Post-quote pipeline: cleanup_tabs → voice_filter --quote → 3s sleep →
    //   post_quote → watchdog QUOTE → critique --quote
    runScriptLog(path.join(PROJECT_ROOT, 'runner/cleanup_tabs.js'));
    const quoteResult = postQuoteTweet({ cycle });
    metrics.postAttempted = Boolean(quoteResult.attempted);
    metrics.postSuccess = quoteResult.attempted ? quoteResult.posted : null;
    metrics.postSuppressed = Boolean(quoteResult.suppressed);
    metrics.postSuppressionReason = quoteResult.suppressionReason || null;

    // Watchdog: verify quote was posted
    runScriptLog(path.join(PROJECT_ROOT, 'runner/watchdog.js'), '', {
      CYCLE_TYPE: 'QUOTE',
      CYCLE_NUMBER: String(cycle),
    });

    // Coherence critique
    runScriptLog(path.join(PROJECT_ROOT, 'runner/critique.js'),
      `--quote --cycle "${cycle}"`);

    // ── Tool execution ────────────────────────────────────────────────────
    if (fileExists(config.TOOL_REQUEST_PATH)) {
      try {
        log('tool request detected (QUOTE) — executing...');
        const toolResult = executeToolRequest();
        const name = toolResult.workflow ? 'workflow' : toolResult.tool;
        log(`tool "${name}" completed: ${toolResult.status}`);
        metrics.toolExecuted = true;
      } catch (e) {
        log(`tool execution failed: ${e.message}`);
      }
    }

    // ── Human request ─────────────────────────────────────────────────────
    try { notify.checkHumanRequest(); } catch (e) { log(`human_request check failed: ${e.message}`); }

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
      try { fs.unlinkSync(path.join(config.STATE_DIR, 'tweet_attempt.json')); } catch {}

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

    // Merge claim tracker delta
    runScript(path.join(PROJECT_ROOT, 'runner/apply_claim_tracker_delta.js'));

    // Detect drift
    runScriptLog(path.join(PROJECT_ROOT, 'runner/detect_drift.js'));

    // Post regular tweet (journal URL fix → critique gate → voice filter → post)
    const tweetResult = postRegularTweet({ today, hour, cycle });
    metrics.postAttempted = Boolean(tweetResult.attempted);
    metrics.postSuccess = tweetResult.attempted ? tweetResult.posted : null;
    metrics.postSuppressed = Boolean(tweetResult.suppressed);
    metrics.postSuppressionReason = tweetResult.suppressionReason || null;

    // Watchdog: verify tweet was posted
    runScriptLog(path.join(PROJECT_ROOT, 'runner/watchdog.js'), '', {
      CYCLE_TYPE: 'TWEET',
      CYCLE_NUMBER: String(cycle),
    });

    // Git commit + push
    commitAndPush({
      paths: ['journals/', 'checkpoints/', 'state/', 'articles/', 'daily/', 'ponders/'],
      message: `cycle ${cycle}: ${today} ${now}`,
    });

    // Deploy: Vercel (legacy) + GCS sync for Cloud Run
    const vercelHook = process.env.VERCEL_DEPLOY_HOOK || '';
    if (vercelHook) {
      triggerVercelDeploy(vercelHook);
    }
    syncToGCS();

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

    // ── Tool execution ────────────────────────────────────────────────────
    if (fileExists(config.TOOL_REQUEST_PATH)) {
      try {
        log('tool request detected (TWEET) — executing...');
        const toolResult = executeToolRequest();
        const name = toolResult.workflow ? 'workflow' : toolResult.tool;
        log(`tool "${name}" completed: ${toolResult.status}`);
        metrics.toolExecuted = true;
      } catch (e) {
        log(`tool execution failed: ${e.message}`);
      }
    }

    // ── Human request ─────────────────────────────────────────────────────
    try { notify.checkHumanRequest(); } catch (e) { log(`human_request check failed: ${e.message}`); }
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
  // Read cadence-adjusted interval (may differ from config default)
  const cadenceDir = readDirectives();
  const effectiveInterval = cadenceDir.cycle_interval_sec || config.BROWSE_INTERVAL;
  const elapsed = Math.floor((Date.now() - cycleStart) / 1000);
  const wait = effectiveInterval - elapsed;

  if (effectiveInterval !== config.BROWSE_INTERVAL) {
    log(`cadence interval: ${effectiveInterval}s (default: ${config.BROWSE_INTERVAL}s)`);
  }

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
    postSuppressed: metrics.postSuppressed,
    postSuppressionReason: metrics.postSuppressionReason,
    browserRestarted: metrics.browserRestarted,
    toolExecuted: metrics.toolExecuted,
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
    if (elapsed > effectiveInterval * 2) {
      log(`post-sleep detected during cycle (elapsed=${elapsed}s) — restarting browser...`);
      startBrowser();
      sleepSec(10);
      log('browser restarted after sleep wake');
    }

    expectedWakeTs = 0;
    setImmediate(runOneCycle);
  }
}

// Kick off the first cycle
runOneCycle();
