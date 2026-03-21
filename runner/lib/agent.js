'use strict';

/**
 * runner/lib/agent.js — openclaw agent runner with timeout + fast-fail retry
 *
 * Ported 1:1 from run.sh lines 130-159 (agent_run function).
 *
 * Behavior:
 *   - Runs `openclaw agent` as a background child process
 *   - Hard-kills after 900s (prevents multi-hour hangs)
 *   - If agent exits in < 45s with error, retries once (transient model/gateway error)
 *   - Returns exit code of the agent process
 *
 * Synchronous — blocks until agent completes or is killed.
 */

const { spawn } = require('child_process');
const { execSync } = require('child_process');

function log(msg) {
  console.log(`[run] ${msg}`);
}

/**
 * agentRun(args)
 * Bash: run.sh lines 130-159
 *
 * @param {object} opts
 * @param {string} opts.agent    - agent name (e.g. 'x-hunter', 'x-hunter-tweet')
 * @param {string} opts.message  - prompt message
 * @param {string} [opts.thinking] - thinking level ('high', 'low', etc.)
 * @param {string} [opts.verbose]  - verbose mode ('on' or omit)
 * @returns {number} exit code (0 = success)
 */
function agentRun({ agent, message, thinking, verbose }) {
  const MAX_TIMEOUT = 900; // seconds
  const FAST_FAIL_THRESHOLD = 45; // seconds

  for (let attempt = 1; attempt <= 2; attempt++) {
    const startTs = Date.now();

    // Build args array
    const args = ['agent', '--agent', agent, '--message', message];
    if (thinking) { args.push('--thinking', thinking); }
    if (verbose) { args.push('--verbose', verbose); }

    // Spawn as child process (matching bash's `openclaw agent "$@" &`)
    const child = spawn('openclaw', args, {
      stdio: 'inherit',
      env: process.env,
    });

    let exitCode = null;
    let killed = false;

    // Wait for exit synchronously (block main thread like bash does)
    const result = waitForChild(child, MAX_TIMEOUT);
    exitCode = result.exitCode;
    killed = result.killed;

    const elapsed = Math.floor((Date.now() - startTs) / 1000);

    if (killed) {
      log(`WARNING: openclaw agent exceeded ${MAX_TIMEOUT}s — force-killed (pid ${child.pid})`);
      return 1;
    }

    // Fast-fail retry: if exited quickly with error and this is first attempt
    if (exitCode !== 0 && elapsed < FAST_FAIL_THRESHOLD && attempt < 2) {
      log(`agent exited in ${elapsed}s with error — retrying once (attempt ${attempt}/2)`);
      sleep(5000);
      continue;
    }

    return exitCode;
  }
  return 1; // shouldn't reach here
}

/**
 * Block until child exits or timeout, polling every 500ms.
 * On timeout, sends SIGKILL (matching bash `kill -9`).
 *
 * Uses a synchronous polling approach to match bash's blocking `wait` behavior.
 */
function waitForChild(child, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let exitCode = null;
  let killed = false;

  child.on('exit', (code) => {
    exitCode = code;
  });

  // Synchronous poll — blocks the event loop like bash `wait`
  while (exitCode === null) {
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch {}
      killed = true;
      // Give a moment for the exit event to fire
      execSync('sleep 1');
      break;
    }
    // Sleep 500ms — matching bash's sleep 5 check but more responsive
    execSync('sleep 0.5');
  }

  return { exitCode: exitCode ?? 1, killed };
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

module.exports = { agentRun };
