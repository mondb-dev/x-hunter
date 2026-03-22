'use strict';

/**
 * runner/lib/git.js — git commit/push + Vercel deploy helpers
 *
 * Ported 1:1 from run.sh:
 *   - git add/commit/push    lines 789-795 (tweet cycle), 955-960 (daily)
 *   - Vercel deploy hook      lines 797-800 (tweet cycle), 962-964 (daily)
 *
 * All operations are synchronous to match bash behavior.
 */

const { execSync } = require('child_process');
const config = require('./config');

function log(msg) {
  console.log(`[git] ${msg}`);
}

// ── commitAndPush ────────────────────────────────────────────────────────────
/**
 * git add + commit + push with configurable paths and message.
 * Bash: git -C "$PROJECT_ROOT" add journals/ checkpoints/ state/ articles/ daily/ ponders/
 *       git -C "$PROJECT_ROOT" commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}"
 *       git -C "$PROJECT_ROOT" push origin main
 *
 * Each command ignores errors to match `2>/dev/null || true`.
 *
 * @param {Object} opts
 * @param {string[]} opts.paths - relative paths to add (e.g. ['journals/', 'state/'])
 * @param {string} opts.message - commit message
 */
function commitAndPush({ paths, message }) {
  const root = config.PROJECT_ROOT;
  const addPaths = paths.join(' ');
  try {
    execSync(`git -C "${root}" add ${addPaths}`, { stdio: 'ignore' });
  } catch {}
  try {
    execSync(`git -C "${root}" commit -m "${message}"`, { stdio: 'ignore' });
  } catch {}
  try {
    execSync(`git -C "${root}" push origin main`, { stdio: 'ignore' });
  } catch {}
  log('push done');
}

// ── triggerVercelDeploy ──────────────────────────────────────────────────────
/**
 * POST to the Vercel deploy hook URL if configured.
 * Bash: curl -s -X POST "$VERCEL_DEPLOY_HOOK" > /dev/null 2>&1 || true
 *
 * @param {string} [hookUrl] - VERCEL_DEPLOY_HOOK env value (may be undefined)
 */
function triggerVercelDeploy(hookUrl) {
  if (!hookUrl) return;
  try {
    execSync(`curl -s -X POST "${hookUrl}"`, { stdio: 'ignore', timeout: 15000 });
    log('Vercel deploy hook triggered');
  } catch {}
}

module.exports = {
  commitAndPush,
  triggerVercelDeploy,
};
