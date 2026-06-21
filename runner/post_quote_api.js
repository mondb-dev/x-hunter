#!/usr/bin/env node
/**
 * runner/post_quote_api.js — post a quote-tweet via X API v2
 *
 * Drop-in replacement for post_quote.js (CDP-based).
 * Reads state/quote_draft.txt:
 *   Line 1: source tweet URL
 *   Lines 2+: commentary text
 *
 * Posts via X API v2 using OAuth 1.0a with quote_tweet_id.
 *
 * Exit 0 = posted, exit 1 = failed
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// Load .env when running standalone (orchestrator pre-loads via run.sh)
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const { postQuoteTweet, postTweet } = require("./x_api");
const { logQuote } = require("./posts_log");
const { HANDLE, clearFile, writeAttempt, writeResult } = require("./post_result");

const ROOT        = path.resolve(__dirname, "..");
const DRAFT_FILE  = path.join(ROOT, "state", "quote_draft.txt");
const RESULT_FILE = path.join(ROOT, "state", "quote_result.txt");
const ATTEMPT_FILE = path.join(ROOT, "state", "quote_attempt.json");
const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;

function buildUrlFallbackTweet(commentary, sourceUrl) {
  const clean = String(commentary || "").replace(/\s+/g, " ").trim();
  const maxCommentary = 255; // leaves room for newline + t.co-shortened URL
  const trimmed = clean.length > maxCommentary
    ? clean.slice(0, maxCommentary - 3).trimEnd() + "..."
    : clean;
  return `${trimmed}\n${sourceUrl}`;
}

function isQuoteCapabilityError(err) {
  const msg = String(err?.message || "");
  return err?.statusCode === 403 &&
    /Quoting this post is not allowed/i.test(msg);
}

(async () => {
  clearFile(RESULT_FILE);

  // Read draft
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error("[post_quote_api] no quote_draft.txt found — skipping");
    writeAttempt(ATTEMPT_FILE, { kind: "quote", outcome: "failed", reason: "draft_missing", cycle: CYCLE });
    process.exit(1);
  }

  const raw = fs.readFileSync(DRAFT_FILE, "utf-8").trim();
  const lines = raw.split("\n");
  const sourceUrl = (lines[0] || "").trim();
  const commentary = lines.slice(1).join("\n").trim();

  if (!sourceUrl || !sourceUrl.startsWith("https://")) {
    console.error("[post_quote_api] invalid source URL on line 1");
    writeAttempt(ATTEMPT_FILE, { kind: "quote", outcome: "failed", reason: "invalid_source_url", cycle: CYCLE });
    process.exit(1);
  }

  if (!commentary) {
    console.error("[post_quote_api] no commentary text found on lines 2+");
    writeAttempt(ATTEMPT_FILE, { kind: "quote", outcome: "failed", reason: "commentary_empty", cycle: CYCLE });
    process.exit(1);
  }

  console.log(`[post_quote_api] quoting ${sourceUrl}`);
  console.log(`[post_quote_api] commentary (${commentary.length} chars): ${commentary.slice(0, 80)}...`);

  try {
    const result = await postQuoteTweet(commentary, sourceUrl);
    const tweetId = result.id;
    const tweetUrl = `https://x.com/${HANDLE}/status/${tweetId}`;

    console.log(`[post_quote_api] SUCCESS: ${tweetUrl}`);

    writeResult(RESULT_FILE, tweetUrl);
    writeAttempt(ATTEMPT_FILE, {
      kind: "quote",
      outcome: "confirmed",
      confirmed_url: tweetUrl,
      tweet_id: tweetId,
      source_url: sourceUrl,
      method: "api",
      cycle: CYCLE,
    });

    logQuote({ source_url: sourceUrl, content: commentary, tweet_url: tweetUrl, cycle: CYCLE });
  } catch (err) {
    if (isQuoteCapabilityError(err)) {
      const fallbackText = buildUrlFallbackTweet(commentary, sourceUrl);
      console.warn("[post_quote_api] quote blocked by X API policy — falling back to regular tweet with source URL");
      try {
        const result = await postTweet(fallbackText);
        const tweetId = result.id;
        const tweetUrl = `https://x.com/${HANDLE}/status/${tweetId}`;

        console.log(`[post_quote_api] FALLBACK SUCCESS: ${tweetUrl}`);

        writeResult(RESULT_FILE, tweetUrl);
        writeAttempt(ATTEMPT_FILE, {
          kind: "quote",
          outcome: "confirmed",
          confirmed_url: tweetUrl,
          tweet_id: tweetId,
          source_url: sourceUrl,
          method: "api_fallback_tweet",
          cycle: CYCLE,
        });

        logQuote({
          source_url: sourceUrl,
          content: fallbackText,
          tweet_url: tweetUrl,
          cycle: CYCLE,
          mode: "url_tweet_fallback",
        });
        process.exit(0);
      } catch (fallbackErr) {
        console.error(`[post_quote_api] fallback error: ${fallbackErr.message}`);
        writeAttempt(ATTEMPT_FILE, {
          kind: "quote",
          outcome: "failed",
          reason: "api_fallback_error",
          error: fallbackErr.message,
          status_code: fallbackErr.statusCode || null,
          source_url: sourceUrl,
          method: "api_fallback_tweet",
          cycle: CYCLE,
        });
        process.exit(1);
      }
    }

    console.error(`[post_quote_api] error: ${err.message}`);
    writeAttempt(ATTEMPT_FILE, {
      kind: "quote",
      outcome: "failed",
      reason: "api_error",
      error: err.message,
      status_code: err.statusCode || null,
      source_url: sourceUrl,
      method: "api",
      cycle: CYCLE,
    });
    process.exit(1);
  }

  process.exit(0);
})();
