#!/usr/bin/env node
/**
 * runner/watchdog.js — post-action success checker + auto-retry
 *
 * Called synchronously by run.sh after each QUOTE or TWEET posting attempt.
 * Checks whether the action produced a result file. If not, retries once.
 * Patches posts_log.json on successful retry (mirrors run.sh logic).
 *
 * Usage:
 *   CYCLE_TYPE=QUOTE node runner/watchdog.js
 *   CYCLE_TYPE=TWEET  node runner/watchdog.js
 *
 * Exit 0 always — failures are logged, not fatal to the cycle.
 */

"use strict";

const fs            = require("fs");
const path          = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const QUOTE_DRAFT  = path.join(ROOT, "state", "quote_draft.txt");
const QUOTE_RESULT = path.join(ROOT, "state", "quote_result.txt");
const TWEET_DRAFT  = path.join(ROOT, "state", "tweet_draft.txt");
const TWEET_RESULT = path.join(ROOT, "state", "tweet_result.txt");
const POSTS_LOG    = path.join(ROOT, "state", "posts_log.json");

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

  } else {
    console.error(`[watchdog] unknown CYCLE_TYPE: "${TYPE}" — must be QUOTE or TWEET`);
  }

  process.exit(0);
})();
