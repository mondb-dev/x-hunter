'use strict';

/**
 * runner/lib/browser.js — browser lifecycle management (no OpenClaw)
 *
 * Manages Chrome via direct CDP connection. No gateway daemon needed —
 * the Gemini agent connects to Chrome directly via puppeteer-core.
 *
 * Chrome is started via systemd (sebastian-browser.service) or manually
 * with: google-chrome --remote-debugging-port=18801 --user-data-dir=...
 */

const { execSync } = require('child_process');
const fs = require('fs');
const config = require('./config');

const CDP_PORT = config.CDP_PORT;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Synchronous HTTP OK check via curl. */
function httpOkSync(url, timeoutMs = 5000) {
  try {
    execSync(
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

// ── Chrome process helpers ───────────────────────────────────────────────────

/** Find Chrome PID listening on CDP_PORT. */
function findChromePid() {
  try {
    const out = execSync(
      `lsof -ti :${CDP_PORT} 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    return out ? parseInt(out.split('\n')[0], 10) : null;
  } catch {
    return null;
  }
}

/** Kill Chrome process on CDP port. */
function killChrome() {
  const pid = findChromePid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    sleep(2000);
    // Force kill if still alive
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/** Start Chrome with remote debugging. */
function launchChrome() {
  const profileDir = process.env.CHROME_USER_DATA_DIR ||
    `${process.env.HOME}/.config/google-chrome/x-hunter`;
  const chromeBin = process.env.CHROME_BIN || findChromeBin();

  if (!chromeBin) {
    log('WARNING: Chrome binary not found — cannot start browser');
    return;
  }

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--headless=new',
  ];

  try {
    // Start Chrome in the background — detached so it survives this process
    const { spawn } = require('child_process');
    const child = spawn(chromeBin, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log(`Chrome launched (pid=${child.pid}) on port ${CDP_PORT}`);
  } catch (err) {
    log(`WARNING: failed to launch Chrome: ${err.message}`);
  }
}

/** Find Chrome binary on the system. */
function findChromeBin() {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  // Try which
  try {
    return execSync('which google-chrome 2>/dev/null || which chromium 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000,
    }).trim() || null;
  } catch {
    return null;
  }
}

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * startBrowser()
 * Stop any existing Chrome on CDP port, then launch fresh.
 * Poll CDP for readiness.
 */
function startBrowser() {
  killChrome();
  sleep(1000);

  // Check if Chrome is managed by systemd
  try {
    const state = execSync('systemctl is-active sebastian-browser.service 2>/dev/null', {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    if (state === 'active' || state === 'activating') {
      // Let systemd manage it — just restart
      try {
        execSync('sudo systemctl restart sebastian-browser.service', {
          stdio: 'ignore', timeout: 15000,
        });
        log('restarted sebastian-browser.service');
      } catch {}
    } else {
      launchChrome();
    }
  } catch {
    // No systemd or not a systemd-managed Chrome — launch directly
    launchChrome();
  }

  // Poll CDP for readiness
  for (let i = 0; i < 15; i++) {
    sleep(2000);
    if (httpOkSync(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
      log(`browser CDP ready (${i + 1}x2s)`);

      // Ensure at least one page tab exists
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
        sleep(4000);
      }
      return;
    }
  }
  log('WARNING: browser CDP not ready after 30s — proceeding');
}

/**
 * checkBrowser()
 * Functional health check — CDP /json/version HTTP check.
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
 * 3-attempt escalation: check → start browser → poll.
 */
function ensureBrowser() {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (checkBrowser()) {
      if (attempt > 0) log(`browser recovered after ${attempt} restart(s)`);
      return true;
    }
    log(`browser check failed (attempt ${attempt + 1}/3) — restarting browser`);
    startBrowser();
    waitForBrowserService(30);
  }
  log('WARNING: browser unresponsive after 3 restart attempts — proceeding');
  return false;
}

module.exports = {
  startBrowser,
  checkBrowser,
  waitForBrowserService,
  ensureBrowser,
};
