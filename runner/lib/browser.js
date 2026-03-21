'use strict';

/**
 * runner/lib/browser.js — browser + gateway lifecycle management
 *
 * 6 functions ported 1:1 from run.sh lines 161-270.
 * Every poll interval, timeout, and escalation step matches the bash original.
 *
 * All functions are synchronous (execSync) to match bash behavior — the runner
 * is single-threaded and waits for each step before proceeding.
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const config = require('./config');

const CDP_PORT = config.CDP_PORT;
const GATEWAY_PORT = config.GATEWAY_PORT;
const GATEWAY_ERR_LOG = config.GATEWAY_ERR_LOG;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** HTTP GET with timeout — returns true if 2xx, false otherwise. */
function httpOk(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      // Consume response data to free up memory
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Synchronous HTTP OK check (wraps the async helper). */
function httpOkSync(url, timeoutMs = 5000) {
  try {
    // Use a child process to do the HTTP check synchronously,
    // matching the bash curl -sf pattern exactly.
    const code = execSync(
      `curl -sf "${url}" -o /dev/null --max-time ${Math.ceil(timeoutMs / 1000)}`,
      { stdio: 'ignore', timeout: timeoutMs + 2000 }
    );
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function log(msg) {
  console.log(`[run] ${msg}`);
}

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * restartGateway()
 * Bash: run.sh lines 161-179 (restart_gateway)
 *
 * Kill existing gateway directly (avoids openclaw's 60s internal timeout),
 * start fresh, poll HTTP health 15×2s.
 */
function restartGateway() {
  log('restarting gateway...');
  try { execSync('pkill -f "openclaw-gateway"', { stdio: 'ignore' }); } catch {}
  sleep(2000);
  try { execSync('openclaw gateway start', { stdio: 'ignore' }); } catch {}

  for (let i = 0; i < 15; i++) {
    sleep(2000);
    if (httpOkSync(`http://127.0.0.1:${GATEWAY_PORT}/`)) {
      log(`gateway healthy (${i + 1}x2s)`);
      return;
    }
  }
  log('WARNING: gateway not healthy after 30s — proceeding');
}

/**
 * startBrowser()
 * Bash: run.sh lines 181-210 (start_browser)
 *
 * Stop/start browser profile, poll CDP 15×2s, create tab if zero.
 */
function startBrowser() {
  try { execSync('openclaw browser --browser-profile x-hunter stop', { stdio: 'ignore' }); } catch {}
  sleep(1000);
  try { execSync('openclaw browser --browser-profile x-hunter start', { stdio: 'ignore' }); } catch {}

  for (let i = 0; i < 15; i++) {
    sleep(2000);
    if (httpOkSync(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
      log(`browser CDP ready (${i + 1}x2s)`);

      // Ensure at least one page tab exists — openclaw requires one to attach.
      let tabCount = 0;
      try {
        const out = execSync(
          `curl -sf "http://127.0.0.1:${CDP_PORT}/json/list"`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        tabCount = (out.match(/"type":"page"/g) || []).length;
      } catch {}

      if (tabCount === 0) {
        log('no page tabs found — opening x.com tab via CDP');
        try {
          execSync(
            `curl -sf -X PUT "http://127.0.0.1:${CDP_PORT}/json/new?https://x.com" -o /dev/null`,
            { stdio: 'ignore', timeout: 5000 }
          );
        } catch {}
        sleep(4000); // give tab time to initialise before openclaw attaches
      }
      return;
    }
  }
  log('WARNING: browser CDP not ready after 30s — proceeding');
}

/**
 * checkBrowser()
 * Bash: run.sh lines 212-215 (check_browser)
 *
 * Functional health check via browser_check.js (CDP /json/version HTTP check).
 * Returns true if healthy, false otherwise.
 */
function checkBrowser() {
  try {
    execSync(`node "${config.PROJECT_ROOT}/runner/browser_check.js"`, {
      stdio: 'ignore',
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * waitForBrowserService(timeoutSec)
 * Bash: run.sh lines 219-231 (wait_for_browser_service)
 *
 * Poll checkBrowser() every 2s until ready or timeout.
 */
function waitForBrowserService(timeoutSec = 30) {
  let elapsed = 0;
  while (elapsed < timeoutSec) {
    if (checkBrowser()) {
      log(`browser service ready (${elapsed}s)`);
      return true;
    }
    sleep(2000);
    elapsed += 2;
  }
  log(`WARNING: browser service not ready after ${timeoutSec}s`);
  return false;
}

/**
 * ensureBrowser()
 * Bash: run.sh lines 234-250 (ensure_browser)
 *
 * 3-attempt escalation: check → restart gateway → start browser → poll.
 */
function ensureBrowser() {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (checkBrowser()) {
      if (attempt > 0) log(`browser recovered after ${attempt} restart(s)`);
      return true;
    }
    log(`browser check failed (attempt ${attempt + 1}/3) — restarting gateway + browser`);
    restartGateway();
    startBrowser();
    waitForBrowserService(30);
  }
  log('WARNING: browser unresponsive after 3 restart attempts — proceeding');
  return false;
}

/**
 * checkAndFixGatewayTimeout(beforeLines)
 * Bash: run.sh lines 255-270 (check_and_fix_gateway_timeout)
 *
 * Compare gateway error log line counts before vs after agent run.
 * If "timed out after 20000ms" appeared, restart gateway + browser.
 *
 * @param {number} beforeLines - line count captured before agent_run
 */
function checkAndFixGatewayTimeout(beforeLines) {
  if (!fs.existsSync(GATEWAY_ERR_LOG)) return;

  let afterLines = 0;
  try {
    const content = fs.readFileSync(GATEWAY_ERR_LOG, 'utf-8');
    afterLines = content.split('\n').length;
  } catch { return; }

  const newLines = afterLines - beforeLines;
  if (newLines <= 0) return;

  try {
    const tail = execSync(
      `tail -n ${newLines} "${GATEWAY_ERR_LOG}"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    if (tail.includes('browser control service (timed out')) {
      log('browser control service timed out during agent run — restarting gateway');
      restartGateway();
      startBrowser();
      sleep(15000);
      if (checkBrowser()) {
        log('gateway browser service recovered');
      } else {
        log('WARNING: gateway still unhealthy after restart');
      }
    }
  } catch {}
}

/**
 * countGatewayErrLines()
 * Helper: capture current gateway error log line count (for before/after diff).
 */
function countGatewayErrLines() {
  if (!fs.existsSync(GATEWAY_ERR_LOG)) return 0;
  try {
    const content = fs.readFileSync(GATEWAY_ERR_LOG, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * checkGatewayPort()
 * Helper: quick check that gateway HTTP port is responding (distinct from CDP).
 */
function checkGatewayPort() {
  return httpOkSync(`http://127.0.0.1:${GATEWAY_PORT}/`);
}

module.exports = {
  restartGateway,
  startBrowser,
  checkBrowser,
  waitForBrowserService,
  ensureBrowser,
  checkAndFixGatewayTimeout,
  countGatewayErrLines,
  checkGatewayPort,
};
