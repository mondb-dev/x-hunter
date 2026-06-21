'use strict';

/**
 * runner/lib/agent.js — openclaw agent runner with timeout + fast-fail retry
 *
 * Ported 1:1 from run.sh lines 130-159 (agent_run function).
 *
 * Behavior:
 *   - Runs `openclaw agent` synchronously via spawnSync
 *   - Hard-kills (SIGKILL) after 900s (prevents multi-hour hangs)
 *   - If agent exits in < 45s with error, retries once (transient model/gateway error)
 *   - Returns exit code of the agent process
 *
 * Synchronous — blocks until agent completes or is killed.
 */

const { spawnSync } = require('child_process');

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
  const MAX_TIMEOUT_MS = 900_000; // 900 seconds
  const FAST_FAIL_THRESHOLD = 45; // seconds

  for (let attempt = 1; attempt <= 2; attempt++) {
    const startTs = Date.now();

    // Build args array
    const args = ['agent', '--agent', agent, '--message', message];
    if (thinking) { args.push('--thinking', thinking); }
    if (verbose) { args.push('--verbose', verbose); }

    // spawnSync blocks until child exits or timeout — no event loop issues.
    // On timeout, sends killSignal (SIGKILL, matching bash `kill -9`).
    const result = spawnSync('openclaw', args, {
      stdio: 'inherit',
      env: process.env,
      timeout: MAX_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    const elapsed = Math.floor((Date.now() - startTs) / 1000);

    // Timeout → killed by signal
    if (result.signal === 'SIGKILL') {
      log(`WARNING: openclaw agent exceeded ${MAX_TIMEOUT_MS / 1000}s — force-killed`);
      return 1;
    }

    const exitCode = result.status ?? 1;

    // Fast-fail retry: if exited quickly with error and this is first attempt
    if (exitCode !== 0 && elapsed < FAST_FAIL_THRESHOLD && attempt < 2) {
      log(`agent exited in ${elapsed}s with error — retrying once (attempt ${attempt}/2)`);
      spawnSync('sleep', ['5'], { stdio: 'ignore' });
      continue;
    }

    return exitCode;
  }
  return 1; // shouldn't reach here
}

module.exports = { agentRun };
