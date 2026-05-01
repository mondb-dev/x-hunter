#!/usr/bin/env node
/**
 * runner/meta_watchdog.js — runtime META rollback watchdog
 *
 * Called by the orchestrator after any BROWSE cycle where all agents
 * exited with code 1 (complete failure). Counts consecutive failures and,
 * if a recent META commit is found responsible, reverts it automatically.
 *
 * Logic:
 *   1. Increment consecutive_browse_failures counter in meta_watchdog_state.json
 *   2. If counter >= FAILURE_THRESHOLD, look for a META commit within LOOKBACK_MS
 *   3. If found: git revert --no-edit, push, log to proposal_history, alert
 *   4. Reset counter regardless (either we rolled back or we hit a different problem)
 *
 * Called with env BROWSE_EXIT_CODES="1,1" (comma-separated agent exit codes).
 * Only fires when ALL exit codes are non-zero.
 *
 * Exit 0 always — this is a best-effort background check.
 */

"use strict";

const fs            = require("fs");
const path          = require("path");
const { execFileSync, execSync } = require("child_process");

const ROOT          = path.resolve(__dirname, "..");
const STATE_PATH    = path.join(ROOT, "state", "meta_watchdog_state.json");
const HISTORY_PATH  = path.join(ROOT, "state", "proposal_history.json");

const FAILURE_THRESHOLD = 5;          // consecutive all-fail BROWSE cycles before revert
const LOOKBACK_MS       = 3 * 60 * 60 * 1000;  // only revert META commits within 3h

function log(msg) { console.log(`[meta_watchdog] ${msg}`); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")); }
  catch { return { consecutive_browse_failures: 0, last_revert_at: null, last_revert_hash: null }; }
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function parseExitCodes() {
  const raw = process.env.BROWSE_EXIT_CODES || "";
  if (!raw) return [];
  return raw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

function allFailed(codes) {
  return codes.length > 0 && codes.every(c => c !== 0);
}

/**
 * Find the most recent META commit (message starts with "meta:") within LOOKBACK_MS.
 * Returns { hash, message, ageMs } or null.
 */
function findRecentMetaCommit() {
  try {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const out = execFileSync("git", [
      "-C", ROOT,
      "log", "--oneline", "--format=%H %ct %s",
      `--since=${since}`,
      "main",
    ], { encoding: "utf-8", timeout: 15_000 }).trim();

    for (const line of out.split("\n")) {
      const m = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const [, hash, ts, message] = m;
      if (message.startsWith("meta:") || message.startsWith("fix: restore")) {
        const ageMs = Date.now() - parseInt(ts, 10) * 1000;
        return { hash, message, ageMs };
      }
    }
    return null;
  } catch (e) {
    log(`git log failed: ${e.message}`);
    return null;
  }
}

/**
 * Attempt git revert --no-edit of a specific commit, then push.
 * Returns { ok, revertHash, error }.
 */
function revertCommit(hash) {
  try {
    execFileSync("git", ["-C", ROOT, "revert", "--no-edit", hash], {
      stdio: "pipe", timeout: 30_000,
    });
    const revertHash = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
      encoding: "utf-8", timeout: 10_000,
    }).trim();
    try {
      execSync(`git -C "${ROOT}" push origin main`, { stdio: "pipe", timeout: 30_000 });
      log(`reverted ${hash.slice(0, 8)} and pushed`);
    } catch (pushErr) {
      log(`revert committed locally but push failed: ${pushErr.message}`);
    }
    return { ok: true, revertHash };
  } catch (e) {
    // If revert fails (e.g. conflicts), abort and return error
    try { execFileSync("git", ["-C", ROOT, "revert", "--abort"], { stdio: "ignore", timeout: 10_000 }); } catch {}
    return { ok: false, error: e.message };
  }
}

function appendHistory(revertedHash, revertHash, message, error) {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
    const entry = h.proposals.find(p => p.merge_commit === revertedHash);
    if (entry) {
      entry.reverted = true;
      entry.revert_reason = error
        ? `auto-revert failed: ${error}`
        : "auto-reverted by meta_watchdog after consecutive browse failures";
      entry.revert_commit = revertHash || null;
      entry.reverted_at = new Date().toISOString();
    } else {
      // No matching history entry — append a standalone record
      h.proposals.push({
        id: `revert_${revertedHash.slice(0, 8)}`,
        title: `Auto-revert: ${message}`,
        status: error ? "revert_failed" : "reverted",
        reverted: !error,
        revert_reason: error || "consecutive browse failures",
        revert_commit: revertHash || null,
        reverted_at: new Date().toISOString(),
      });
    }
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2));
  } catch { /* non-fatal */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(function main() {
  const exitCodes = parseExitCodes();

  const state = loadState();

  if (!allFailed(exitCodes)) {
    // At least one agent succeeded — reset failure counter
    if (state.consecutive_browse_failures > 0) {
      log(`reset counter (was ${state.consecutive_browse_failures}, at least one agent succeeded)`);
      state.consecutive_browse_failures = 0;
      saveState(state);
    }
    process.exit(0);
  }

  state.consecutive_browse_failures = (state.consecutive_browse_failures || 0) + 1;
  log(`all agents failed — consecutive failures: ${state.consecutive_browse_failures}/${FAILURE_THRESHOLD}`);

  if (state.consecutive_browse_failures < FAILURE_THRESHOLD) {
    saveState(state);
    process.exit(0);
  }

  // Threshold reached — look for a recent META commit to blame
  log(`threshold reached — scanning for recent META commit within ${LOOKBACK_MS / 3600000}h`);
  const metaCommit = findRecentMetaCommit();

  if (!metaCommit) {
    log("no recent META commit found — cannot auto-revert (manual investigation needed)");
    // Still reset counter so we don't loop
    state.consecutive_browse_failures = 0;
    saveState(state);
    process.exit(0);
  }

  log(`found META commit: ${metaCommit.hash.slice(0, 8)} (${(metaCommit.ageMs / 60000).toFixed(0)}m ago) — "${metaCommit.message}"`);

  // Don't re-revert if we already reverted this hash
  if (state.last_revert_hash === metaCommit.hash) {
    log("already reverted this commit previously — skipping to avoid loop");
    state.consecutive_browse_failures = 0;
    saveState(state);
    process.exit(0);
  }

  log(`reverting ${metaCommit.hash.slice(0, 8)}...`);
  const result = revertCommit(metaCommit.hash);

  if (result.ok) {
    log(`revert successful → ${result.revertHash.slice(0, 8)}`);
    state.consecutive_browse_failures = 0;
    state.last_revert_at = new Date().toISOString();
    state.last_revert_hash = metaCommit.hash;
    appendHistory(metaCommit.hash, result.revertHash, metaCommit.message, null);
  } else {
    log(`revert failed: ${result.error} — manual intervention required`);
    state.consecutive_browse_failures = 0; // reset so we don't keep trying
    appendHistory(metaCommit.hash, null, metaCommit.message, result.error);
  }

  saveState(state);
  process.exit(0);
})();
