'use strict';

/**
 * runner/lib/state.js — state file management helpers
 *
 * Ported 1:1 from run.sh:
 *   - reset_session()        lines 116-126
 *   - clean_stale_locks()    lines 273-285
 *   - backup/restore         lines ~580-600, ~700-730 (inline in quote/tweet blocks)
 *   - chmod dance            lines ~580, ~700 (inline)
 *   - posts_log validation   lines ~590, ~710 (inline)
 *
 * All operations are synchronous to match bash behavior.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');

function log(msg) {
  console.log(`[run] ${msg}`);
}

// ── Session management ───────────────────────────────────────────────────────

/**
 * resetSession(agentName)
 * Bash: run.sh lines 116-126
 *
 * Wipe all JSONL files (not .bak) and clear sessions.json for the agent,
 * so the gateway starts with a fresh context.
 */
function resetSession(agentName) {
  const dir = path.join(
    process.env.HOME || '',
    '.openclaw/agents',
    agentName,
    'sessions'
  );
  if (!fs.existsSync(dir)) return;

  let found = false;
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        fs.unlinkSync(path.join(dir, f));
        found = true;
      }
    }
  } catch {}

  // Wipe sessions.json so gateway starts truly fresh
  try {
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{}');
  } catch {}

  if (found) log(`${agentName} session reset (context flush)`);
}

// ── Lock file cleanup ────────────────────────────────────────────────────────

/**
 * cleanStaleLocks()
 * Bash: run.sh lines 273-285
 *
 * Remove JSONL lock files whose owner PID is no longer running
 * (prevents 10s lock timeouts on stale locks).
 */
function cleanStaleLocks() {
  const agentsDir = path.join(process.env.HOME || '', '.openclaw/agents');
  if (!fs.existsSync(agentsDir)) return;

  let cleaned = 0;
  try {
    const agents = fs.readdirSync(agentsDir);
    for (const agent of agents) {
      const sessionsDir = path.join(agentsDir, agent, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      const files = fs.readdirSync(sessionsDir);
      for (const f of files) {
        if (!f.endsWith('.lock')) continue;
        const lockPath = path.join(sessionsDir, f);
        let lockPid = '';
        try {
          lockPid = fs.readFileSync(lockPath, 'utf-8').trim();
        } catch { lockPid = '0'; }

        if (!lockPid || !isProcessAlive(lockPid)) {
          try { fs.unlinkSync(lockPath); } catch {}
          cleaned++;
        }
      }
    }
  } catch {}

  if (cleaned > 0) log(`cleaned ${cleaned} stale lock(s)`);
}

/** Check if a PID is alive (equivalent to bash `kill -0`). */
function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// ── State backup/restore ─────────────────────────────────────────────────────

/** List of state files that are backed up before agent runs. */
const CRITICAL_STATE_FILES = ['posts_log', 'ontology', 'belief_state'];

/**
 * backupState(fileNames)
 * Bash: inline in quote/tweet blocks — `cp "$_fp" "${_fp}.bak"`
 *
 * Copy each state JSON to .bak before agent runs.
 * @param {string[]} [fileNames] - base names without .json (default: CRITICAL_STATE_FILES)
 */
function backupState(fileNames = CRITICAL_STATE_FILES) {
  for (const name of fileNames) {
    const fp = path.join(config.STATE_DIR, `${name}.json`);
    if (fs.existsSync(fp)) {
      try {
        fs.copyFileSync(fp, `${fp}.bak`);
      } catch {}
    }
  }
}

/**
 * restoreIfCorrupt(fileNames)
 * Bash: inline in quote/tweet blocks — JSON.parse validation + posts_log entry count check
 *
 * For each file:
 * 1. Try JSON.parse — if malformed, restore from .bak
 * 2. For posts_log specifically, check entry count didn't shrink
 *
 * @param {string[]} [fileNames] - base names without .json (default: CRITICAL_STATE_FILES)
 */
function restoreIfCorrupt(fileNames = CRITICAL_STATE_FILES) {
  for (const name of fileNames) {
    const fp = path.join(config.STATE_DIR, `${name}.json`);
    const bakFp = `${fp}.bak`;
    if (!fs.existsSync(fp) || !fs.existsSync(bakFp)) continue;

    // Check JSON validity
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {
      log(`WARNING: ${name}.json is malformed — restoring from .bak`);
      try { fs.copyFileSync(bakFp, fp); } catch {}
      continue;
    }

    // For posts_log, verify entry count didn't shrink
    if (name === 'posts_log') {
      const curCount = Array.isArray(parsed.posts) ? parsed.posts.length : 0;
      let bakCount = 0;
      try {
        const bakParsed = JSON.parse(fs.readFileSync(bakFp, 'utf-8'));
        bakCount = Array.isArray(bakParsed.posts) ? bakParsed.posts.length : 0;
      } catch {}

      if (curCount < bakCount) {
        log(`WARNING: posts_log.json lost entries (${bakCount} → ${curCount}) — restoring from .bak`);
        try { fs.copyFileSync(bakFp, fp); } catch {}
      }
    }
  }
}

// ── chmod dance ──────────────────────────────────────────────────────────────

/**
 * chmodPostsLog(mode)
 * Bash: `chmod 444 "$PROJECT_ROOT/state/posts_log.json"` / `chmod 644 ...`
 *
 * Make posts_log read-only during agent runs (prevents agent from overwriting it),
 * then restore write permission for post scripts.
 *
 * @param {string} mode - '444' (read-only) or '644' (read-write)
 */
function chmodPostsLog(mode) {
  try {
    fs.chmodSync(config.POSTS_LOG_PATH, mode);
  } catch {}
}

module.exports = {
  resetSession,
  cleanStaleLocks,
  backupState,
  restoreIfCorrupt,
  chmodPostsLog,
  CRITICAL_STATE_FILES,
};
