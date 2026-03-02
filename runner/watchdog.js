#!/usr/bin/env node
/**
 * runner/watchdog.js — post-action success checker + auto-retry
 *
 * Called synchronously by run.sh after each QUOTE, TWEET, or JOURNAL action.
 * Checks whether the action succeeded. If not, retries once.
 *
 * QUOTE / TWEET: checks result file exists, retries posting script once.
 * JOURNAL:       checks latest journal is committed + pushed to git,
 *                and has an entry in arweave_log.json. Retries each step.
 *
 * Usage:
 *   CYCLE_TYPE=QUOTE   node runner/watchdog.js
 *   CYCLE_TYPE=TWEET   node runner/watchdog.js
 *   CYCLE_TYPE=JOURNAL node runner/watchdog.js
 *
 * Exit 0 always — failures are logged, not fatal to the cycle.
 */

"use strict";

const fs                         = require("fs");
const path                       = require("path");
const { execFileSync, execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const QUOTE_DRAFT  = path.join(ROOT, "state", "quote_draft.txt");
const QUOTE_RESULT = path.join(ROOT, "state", "quote_result.txt");
const TWEET_DRAFT  = path.join(ROOT, "state", "tweet_draft.txt");
const TWEET_RESULT = path.join(ROOT, "state", "tweet_result.txt");
const POSTS_LOG    = path.join(ROOT, "state", "posts_log.json");
const JOURNALS_DIR = path.join(ROOT, "journals");
const ARWEAVE_LOG  = path.join(ROOT, "state", "arweave_log.json");

const TYPE = (process.env.CYCLE_TYPE || "").toUpperCase();

// ── Helpers ────────────────────────────────────────────────────────────────

function readTrim(file) {
  try { return fs.readFileSync(file, "utf-8").trim(); } catch { return ""; }
}

function fileExists(file) {
  return fs.existsSync(file);
}

/**
 * Returns true if result file was written AFTER the draft file.
 * Used when both files survive across cycles (tweet cycle).
 */
function resultFresherThanDraft(draftFile, resultFile) {
  if (!fileExists(resultFile)) return false;
  try {
    const draftMtime  = fs.statSync(draftFile).mtimeMs;
    const resultMtime = fs.statSync(resultFile).mtimeMs;
    return resultMtime >= draftMtime;
  } catch {
    return false;
  }
}

/**
 * Patch the last unresolved entry of the given type in posts_log.json
 * with the real URL and a posted_at timestamp.
 */
function patchPostsLog(type, url) {
  try {
    const data  = JSON.parse(fs.readFileSync(POSTS_LOG, "utf-8"));
    const posts = data.posts || [];
    for (let i = posts.length - 1; i >= 0; i--) {
      if (posts[i].type === type && !posts[i].tweet_url) {
        posts[i].tweet_url = url;
        posts[i].posted_at = new Date().toISOString();
        break;
      }
    }
    fs.writeFileSync(POSTS_LOG, JSON.stringify(data, null, 2));
    console.log(`[watchdog] posts_log patched with ${type} URL`);
  } catch (e) {
    console.error(`[watchdog] posts_log patch failed: ${e.message}`);
  }
}

/**
 * Run a posting script synchronously. Returns true if it exited 0.
 */
function runScript(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  try {
    execFileSync(process.execPath, [scriptPath], {
      stdio: "inherit",
      timeout: 120_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {

  // ── QUOTE check ───────────────────────────────────────────────────────────
  if (TYPE === "QUOTE") {
    if (!fileExists(QUOTE_DRAFT)) {
      console.log("[watchdog] QUOTE: no draft written — skipping");
      process.exit(0);
    }

    const result = readTrim(QUOTE_RESULT);
    if (result) {
      console.log(`[watchdog] QUOTE: success confirmed (${result.slice(0, 60)})`);
      process.exit(0);
    }

    // Result missing — retry once
    console.log("[watchdog] QUOTE: no result — retrying post_quote.js...");
    runScript("post_quote.js");

    const retryResult = readTrim(QUOTE_RESULT);
    if (retryResult) {
      console.log(`[watchdog] QUOTE retry OK: ${retryResult}`);
      if (/x\.com\/\w+\/status\/\d+/.test(retryResult)) {
        patchPostsLog("quote", retryResult);
      }
    } else {
      console.error("[watchdog] QUOTE retry also failed — giving up");
    }

  // ── TWEET check ───────────────────────────────────────────────────────────
  } else if (TYPE === "TWEET") {
    const draft = readTrim(TWEET_DRAFT);

    if (!draft || draft === "SKIP") {
      console.log("[watchdog] TWEET: no draft or SKIP — skipping");
      process.exit(0);
    }

    // Both files pre-cleaned at cycle start, so mtime comparison is reliable
    const succeeded = resultFresherThanDraft(TWEET_DRAFT, TWEET_RESULT);
    if (succeeded) {
      const result = readTrim(TWEET_RESULT);
      console.log(`[watchdog] TWEET: success confirmed (${result.slice(0, 60)})`);
      process.exit(0);
    }

    // Result missing or stale — retry once
    console.log("[watchdog] TWEET: no result — retrying post_tweet.js...");
    runScript("post_tweet.js");

    const retryResult = readTrim(TWEET_RESULT);
    if (retryResult) {
      console.log(`[watchdog] TWEET retry OK: ${retryResult}`);
      if (/x\.com\/\w+\/status\/\d+/.test(retryResult)) {
        patchPostsLog("tweet", retryResult);
      }
    } else {
      console.error("[watchdog] TWEET retry also failed — giving up");
    }

  // ── JOURNAL check ─────────────────────────────────────────────────────────
  } else if (TYPE === "JOURNAL") {

    // Find the latest journal HTML file
    let latestJournal = null;
    try {
      const files = fs.readdirSync(JOURNALS_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f))
        .sort();
      if (files.length) latestJournal = path.join(JOURNALS_DIR, files[files.length - 1]);
    } catch (e) {
      console.error(`[watchdog] JOURNAL: could not read journals dir: ${e.message}`);
      process.exit(0);
    }

    if (!latestJournal) {
      console.log("[watchdog] JOURNAL: no journal files found — skipping");
      process.exit(0);
    }

    const journalName = path.basename(latestJournal);
    const relPath     = path.relative(ROOT, latestJournal);
    console.log(`[watchdog] JOURNAL: checking ${journalName}`);

    // ── Check 1: committed to git ──────────────────────────────────────────
    let committed = false;
    try {
      const out = execSync(
        `git -C "${ROOT}" log --oneline -- "${relPath}"`,
        { encoding: "utf-8", timeout: 15_000 }
      ).trim();
      committed = out.length > 0;
    } catch (e) {
      console.error(`[watchdog] JOURNAL: git log check failed: ${e.message}`);
    }

    if (!committed) {
      console.log(`[watchdog] JOURNAL: ${journalName} not committed — committing...`);
      try {
        execSync(
          `git -C "${ROOT}" add journals/ state/ && git -C "${ROOT}" commit -m "watchdog: commit missed journal ${journalName}"`,
          { encoding: "utf-8", timeout: 30_000 }
        );
        console.log("[watchdog] JOURNAL: commit OK");
        committed = true;
      } catch (e) {
        console.error(`[watchdog] JOURNAL: commit failed: ${e.message}`);
      }
    } else {
      console.log("[watchdog] JOURNAL: git commit confirmed");
    }

    // ── Check 2: pushed to remote ──────────────────────────────────────────
    if (committed) {
      let unpushed = 0;
      try {
        const out = execSync(
          `git -C "${ROOT}" rev-list HEAD ^origin/main --count`,
          { encoding: "utf-8", timeout: 15_000 }
        ).trim();
        unpushed = parseInt(out, 10) || 0;
      } catch (e) {
        console.error(`[watchdog] JOURNAL: git rev-list check failed: ${e.message}`);
      }

      if (unpushed > 0) {
        console.log(`[watchdog] JOURNAL: ${unpushed} unpushed commit(s) — pushing...`);
        try {
          execSync(
            `git -C "${ROOT}" push origin main`,
            { encoding: "utf-8", timeout: 60_000 }
          );
          console.log("[watchdog] JOURNAL: git push OK");
        } catch (e) {
          console.error(`[watchdog] JOURNAL: git push failed: ${e.message}`);
        }
      } else {
        console.log("[watchdog] JOURNAL: git push confirmed");
      }
    }

    // ── Check 3: uploaded to Arweave ──────────────────────────────────────
    function arweaveHasEntry(name) {
      try {
        const log = JSON.parse(fs.readFileSync(ARWEAVE_LOG, "utf-8"));
        return (log.uploads || []).some(u => u.file && u.file.includes(name));
      } catch {
        return false;
      }
    }

    if (!arweaveHasEntry(journalName)) {
      console.log(`[watchdog] JOURNAL: ${journalName} not in arweave_log — re-running archive.js...`);
      runScript("archive.js");
      if (arweaveHasEntry(journalName)) {
        console.log("[watchdog] JOURNAL: Arweave upload confirmed");
      } else {
        console.error("[watchdog] JOURNAL: Arweave upload still missing (low balance or network issue)");
      }
    } else {
      console.log("[watchdog] JOURNAL: Arweave upload confirmed");
    }

  // ── HEALTH check ──────────────────────────────────────────────────────────
  } else if (TYPE === "HEALTH") {

    const LOG_FILE    = path.join(ROOT, "runner", "runner.log");
    const STATE_FILE  = path.join(ROOT, "state", "health_state.json");

    // Known error patterns — checked against new log lines only
    const PATTERNS = [
      {
        name:     "run.sh heredoc syntax error",
        re:       /unexpected EOF while looking for matching|syntax error: unexpected end of file/,
        severity: "CRITICAL",
        hint:     "Apostrophe inside heredoc $() — check recent run.sh edits",
      },
      {
        name:     "agent run failed",
        re:       /An unknown error occurred/,
        severity: "ERROR",
        hint:     "Openclaw agent returned a generic error — check gateway/model logs",
      },
      {
        name:     "all model fallbacks exhausted",
        re:       /All models failed/,
        severity: "ERROR",
        hint:     "Every model provider failed — check API keys, billing, and quotas",
      },
      {
        name:     "Anthropic credit balance low",
        re:       /credit balance is too low to access the Anthropic API/,
        severity: "WARN",
        hint:     "Top up Anthropic API credits",
      },
      {
        name:     "LLM request timed out",
        re:       /LLM request timed out/,
        severity: "WARN",
        hint:     "Model API timeout — transient network issue or overloaded provider",
      },
      {
        name:     "Google auth profile unavailable",
        re:       /No available auth profile for google/,
        severity: "WARN",
        hint:     "Google quota exhausted or all profiles in cooldown",
      },
      {
        name:     "CDP timeout",
        re:       /Runtime\.callFunctionOn timed out/,
        severity: "WARN",
        hint:     "Chrome DevTools Protocol call timed out — consider evaluate-based clicks",
      },
      {
        name:     "CDP execution context destroyed",
        re:       /Execution context was destroyed/,
        severity: "WARN",
        hint:     "Page navigated away during a CDP call",
      },
      {
        name:     "Irys balance too low",
        re:       /Irys balance too low/,
        severity: "WARN",
        hint:     "Fund the Solana wallet — Arweave uploads are being skipped",
      },
      {
        name:     "port conflict",
        re:       /EADDRINUSE|address already in use/,
        severity: "WARN",
        hint:     "Port already in use — a process may be stuck holding the port",
      },
      {
        name:     "git push failed",
        re:       /error: failed to push|push.*rejected/,
        severity: "WARN",
        hint:     "Git push to remote failed — check connectivity and branch protection",
      },
    ];

    // Load last-scanned position
    let lastLine = 0;
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      lastLine = s.last_line || 0;
    } catch { /* first run */ }

    // Read log and slice to new lines only
    let newLines = [];
    let totalLines = 0;
    try {
      const lines = fs.readFileSync(LOG_FILE, "utf-8").split("\n");
      totalLines = lines.length;
      newLines   = lines.slice(lastLine);
    } catch (e) {
      console.error(`[watchdog] HEALTH: could not read runner.log: ${e.message}`);
      process.exit(0);
    }

    if (newLines.length === 0) {
      console.log("[watchdog] HEALTH: no new log lines to scan");
      process.exit(0);
    }

    const text = newLines.join("\n");

    // Scan for patterns and collect hits
    const hits = [];
    for (const p of PATTERNS) {
      const match = text.match(new RegExp(p.re.source, "g"));
      if (match) hits.push({ ...p, count: match.length });
    }

    // Save updated position
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ last_line: totalLines, checked_at: new Date().toISOString() }));
    } catch (e) {
      console.error(`[watchdog] HEALTH: could not save state: ${e.message}`);
    }

    // Report
    if (hits.length === 0) {
      console.log(`[watchdog] HEALTH: OK — ${newLines.length} new log line(s) checked, no issues`);
    } else {
      console.log(`[watchdog] HEALTH: ${hits.length} issue type(s) in last ${newLines.length} line(s):`);
      for (const h of hits) {
        console.error(`[watchdog] HEALTH [${h.severity}] ${h.name} (x${h.count}): ${h.hint}`);
      }
    }

  } else {
    console.error(`[watchdog] unknown CYCLE_TYPE: "${TYPE}" — must be QUOTE, TWEET, JOURNAL, or HEALTH`);
  }

  process.exit(0);
})();
