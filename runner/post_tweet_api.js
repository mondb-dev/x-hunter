#!/usr/bin/env node
/**
 * runner/post_tweet_api.js — post tweet via X API v2
 *
 * Drop-in replacement for post_tweet.js (CDP-based).
 * Reads tweet text from state/tweet_draft.txt, posts via X API v2
 * using OAuth 1.0a, writes the same result/attempt/log files.
 *
 * Usage: node post_tweet_api.js
 * Exit 0 = posted, exit 1 = failed
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// Load .env when running standalone (orchestrator pre-loads via run.sh)
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const { postTweet } = require("./x_api");
const { logTweet } = require("./posts_log");
const { HANDLE, clearFile, writeAttempt, writeResult } = require("./post_result");

const ROOT        = path.resolve(__dirname, "..");
const DRAFT_FILE  = path.join(ROOT, "state", "tweet_draft.txt");
const RESULT_FILE = path.join(ROOT, "state", "tweet_result.txt");
const ATTEMPT_FILE = path.join(ROOT, "state", "tweet_attempt.json");
const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;

(async () => {
  clearFile(RESULT_FILE);

  // Read draft
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error("[post_tweet_api] no tweet_draft.txt found — skipping");
    writeAttempt(ATTEMPT_FILE, { kind: "tweet", outcome: "failed", reason: "draft_missing", cycle: CYCLE });
    process.exit(1);
  }

  const tweetText = fs.readFileSync(DRAFT_FILE, "utf-8").trim();
  if (!tweetText) {
    console.error("[post_tweet_api] tweet_draft.txt is empty — skipping");
    writeAttempt(ATTEMPT_FILE, { kind: "tweet", outcome: "failed", reason: "draft_empty", cycle: CYCLE });
    process.exit(1);
  }

  console.log(`[post_tweet_api] posting (${tweetText.length} chars): ${tweetText.slice(0, 80)}...`);

  try {
    const result = await postTweet(tweetText);
    const tweetId = result.id;
    const tweetUrl = `https://x.com/${HANDLE}/status/${tweetId}`;

    console.log(`[post_tweet_api] SUCCESS: ${tweetUrl}`);

    writeResult(RESULT_FILE, tweetUrl);
    writeAttempt(ATTEMPT_FILE, {
      kind: "tweet",
      outcome: "confirmed",
      confirmed_url: tweetUrl,
      tweet_id: tweetId,
      method: "api",
      cycle: CYCLE,
    });

    logTweet({ content: tweetText, tweet_url: tweetUrl, cycle: CYCLE });
  } catch (err) {
    console.error(`[post_tweet_api] error: ${err.message}`);
    writeAttempt(ATTEMPT_FILE, {
      kind: "tweet",
      outcome: "failed",
      reason: "api_error",
      error: err.message,
      status_code: err.statusCode || null,
      method: "api",
      cycle: CYCLE,
    });
    process.exit(1);
  }

  process.exit(0);
})();
