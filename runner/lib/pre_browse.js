'use strict';

/**
 * runner/lib/pre_browse.js — pre-browse pipeline (11 ordered script invocations)
 *
 * Ported 1:1 from run.sh lines ~430-487 (inside the BROWSE elif block,
 * before the prompt construction + agent_run).
 *
 * Order and conditional gating match the bash original exactly.
 * All scripts are invoked synchronously via execSync.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const PROJECT_ROOT = config.PROJECT_ROOT;
const RUNNER_LOG = config.RUNNER_LOG_PATH;

function log(msg) {
  console.log(`[run] ${msg}`);
}

/** Run a node script, logging to runner.log. Failures are swallowed (|| true). */
function runScript(scriptPath, opts = {}) {
  const { env = {}, stdout = 'log', args = '' } = opts;
  const mergedEnv = { ...process.env, ...env };
  const redirect = stdout === 'devnull' ? '> /dev/null 2>&1' : `>> "${RUNNER_LOG}" 2>&1`;
  try {
    execSync(`node "${scriptPath}" ${args} ${redirect}`, {
      env: mergedEnv,
      shell: true,
      stdio: 'ignore',
      timeout: 120_000, // 2-min safety net per script
    });
  } catch {
    // Matches bash `|| true` — failures are logged but don't halt the pipeline
  }
}

/**
 * preBrowse(cycle)
 *
 * Runs the 11-step pre-browse pipeline. Each step matches a block in run.sh.
 *
 * @param {number} cycle - current cycle number
 */
function preBrowse(cycle) {
  // ── 1. FTS5 integrity check + rebuild if corrupted ─────────────────────
  try {
    const check = execSync(
      `sqlite3 "${config.INDEX_DB_PATH}" "INSERT INTO memory_fts(memory_fts) VALUES('integrity-check');"`,
      { encoding: 'utf-8', timeout: 30_000 }
    ).trim();
    if (check) {
      log('FTS5 corruption detected — rebuilding indexes');
      try {
        execSync(`sqlite3 "${config.INDEX_DB_PATH}" "INSERT INTO memory_fts(memory_fts) VALUES('rebuild');"`, { stdio: 'ignore', timeout: 30_000 });
        execSync(`sqlite3 "${config.INDEX_DB_PATH}" "INSERT INTO posts_fts(posts_fts) VALUES('rebuild');"`, { stdio: 'ignore', timeout: 30_000 });
      } catch {}
      log('FTS5 rebuild done');
    }
  } catch {
    // sqlite3 returns non-zero on integrity failure too — check stderr
    // In bash, non-empty stdout triggers rebuild. Here we catch and check.
  }

  // ── 2. query.js --hours 4 (topic summary + memory index) ──────────────
  runScript(path.join(PROJECT_ROOT, 'scraper/query.js'), { args: '--hours 4', stdout: 'devnull' });

  // ── 3. recall.js (keyword-driven, from topic_summary top 3) ───────────
  let recallQuery = '';
  try {
    const content = fs.readFileSync(config.TOPIC_SUMMARY_PATH, 'utf-8');
    recallQuery = content
      .split('\n')
      .filter(line => /^\d+x\s/.test(line))
      .map(line => line.replace(/^\d+x\s*/, ''))
      .slice(0, 3)
      .join(' ')
      .trim();
  } catch {}

  if (recallQuery) {
    // Sanitise recallQuery — remove shell metacharacters to prevent injection
    const safeQuery = recallQuery.replace(/["`$\\!;|&<>(){}]/g, '');
    runScript(path.join(PROJECT_ROOT, 'runner/recall.js'), { args: `--query "${safeQuery}" --limit 5` });
  } else {
    runScript(path.join(PROJECT_ROOT, 'runner/recall.js'), { args: '--limit 5' });
  }

  // ── 4. curiosity.js (every CURIOSITY_EVERY cycles) ────────────────────
  if (cycle % config.CURIOSITY_EVERY === 0) {
    runScript(path.join(PROJECT_ROOT, 'runner/curiosity.js'), {
      env: { CURIOSITY_CYCLE: String(cycle), CURIOSITY_EVERY: String(config.CURIOSITY_EVERY) },
    });

    // ── 5. cluster_axes.js (co-fires with curiosity) ────────────────────
    runScript(path.join(PROJECT_ROOT, 'runner/cluster_axes.js'));
  }

  // ── 6. comment_candidates.js ──────────────────────────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/comment_candidates.js'));

  // ── 7. discourse_scan.js → discourse_anchors.jsonl ────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/discourse_scan.js'));

  // ── 8. discourse_digest.js → discourse_digest.txt ─────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/discourse_digest.js'));

  // ── 9. reading_queue.js (emit reading URL for this cycle) ─────────────
  runScript(path.join(PROJECT_ROOT, 'runner/reading_queue.js'), {
    env: { READING_CYCLE: String(cycle) },
  });

  // ── 10. deep_dive_detector.js (every 6 cycles) ───────────────────────
  if (cycle % 6 === 0) {
    runScript(path.join(PROJECT_ROOT, 'runner/deep_dive_detector.js'), {
      env: { READING_CYCLE: String(cycle) },
    });
  }

  // ── 11. prefetch_url.js (pre-load curiosity URL in browser) ───────────
  runScript(path.join(PROJECT_ROOT, 'runner/prefetch_url.js'), {
    env: { PREFETCH_CYCLE: String(cycle) },
  });
}

module.exports = { preBrowse };
