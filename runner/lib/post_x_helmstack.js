"use strict";
/**
 * runner/lib/post_x_helmstack.js — hunter adapter: X posting via HelmStack.
 *
 * HelmStack backend for post_tweet.js / post_quote.js (selected with
 * POST_BACKEND=helmstack). The browser automation now lives in the standalone
 * `helmstack-social` X engine (tools/helmstack-social); this file keeps the
 * orchestrator contract (runTweet/runQuote with the same draft/result/attempt
 * files and posts_log entries) and maps the engine's result into hunter state.
 *
 * HELMSTACK_DRY_RUN=1 runs everything up to (not including) the Post click.
 */

const fs = require("fs");
const { HelmStackClient, X } = require("../../tools/helmstack-social/src");
const { logTweet, logQuote } = require("../posts_log");
const { HANDLE, clearFile, isConfirmedStatusUrl, writeAttempt, writeResult } = require("../post_result");
const voiceFilter = require("./voice_filter");

const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const OWN_HANDLES = ["sebhunts_ai", "sebastianhunts", "sebastian_hunts"];

async function makeEngine(tag, attemptFile, kind, cycle) {
  const x = new X(new HelmStackClient(), { ownHandle: HANDLE, log: (m) => console.log(`[${tag}] ${m}`) });
  try {
    await x.c.health();
    await x.ensureTab();
    return x;
  } catch (err) {
    console.error(`[${tag}] could not reach HelmStack: ${err.message}`);
    writeAttempt(attemptFile, { kind, outcome: "failed", reason: "helmstack_connect_failed", error: err.message, cycle });
    return null;
  }
}

// ── runTweet ────────────────────────────────────────────────────────────────
async function runTweet({ draftFile, resultFile, attemptFile, cycle }) {
  const tag = "post_tweet.hs";
  clearFile(resultFile);

  if (!fs.existsSync(draftFile)) {
    console.error(`[${tag}] no tweet_draft.txt — skipping`);
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: "draft_missing", cycle });
    return 1;
  }
  const tweetText = fs.readFileSync(draftFile, "utf-8").trim();
  if (!tweetText) {
    console.error(`[${tag}] tweet_draft.txt is empty — skipping`);
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: "draft_empty", cycle });
    return 1;
  }
  console.log(`[${tag}] posting (${tweetText.length} chars): ${tweetText.slice(0, 80)}...`);

  const x = await makeEngine(tag, attemptFile, "tweet", cycle);
  if (!x) return 1;

  let res;
  try {
    res = await x.post(tweetText, { dryRun: DRY_RUN });
  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    clearFile(resultFile);
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: "exception", error: err.message, cycle });
    return 1;
  }

  if (res.dryRun) { writeAttempt(attemptFile, { kind: "tweet", outcome: "dry_run", cycle }); return 0; }
  if (!res.posted) {
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: res.reason || "post_failed", cycle });
    return 1;
  }

  const tweetUrl = res.url && isConfirmedStatusUrl(res.url) ? res.url : "posted";
  if (tweetUrl === "posted") fs.writeFileSync(resultFile, "posted\n");
  else writeResult(resultFile, tweetUrl);
  writeAttempt(attemptFile, { kind: "tweet", outcome: "confirmed", confirmed_url: tweetUrl, backend: "helmstack", cycle });
  logTweet({ content: tweetText, tweet_url: tweetUrl, cycle });
  await x.c.navigate(x.tab, "https://x.com/home").catch(() => {});
  return 0;
}

// ── runQuote ────────────────────────────────────────────────────────────────
async function runQuote({ draftFile, resultFile, attemptFile, cycle }) {
  const tag = "post_quote.hs";
  clearFile(resultFile);

  if (!fs.existsSync(draftFile)) {
    console.error(`[${tag}] no quote_draft.txt — skipping`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "draft_missing", cycle });
    return 1;
  }
  const raw = fs.readFileSync(draftFile, "utf-8").trim();
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const URL_RE = /https:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/;
  let sourceUrl = "", quoteText = "";
  if (lines.length > 0 && URL_RE.test(lines[0]) && lines[0].match(URL_RE)[0] === lines[0]) {
    sourceUrl = lines[0];
    quoteText = lines.slice(1).join(" ").trim();
  } else {
    const urlMatch = lines.join(" ").match(URL_RE);
    if (urlMatch) {
      sourceUrl = urlMatch[0];
      quoteText = lines.join(" ").replace(sourceUrl, "").replace(/\s{2,}/g, " ").trim();
    }
  }

  if (!sourceUrl) {
    console.error(`[${tag}] no valid status URL in quote_draft.txt`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "source_url_missing", cycle });
    return 1;
  }
  if (((sourceUrl.match(/x\.com\/([^/]+)/) || [])[1] || "").toLowerCase() === "sebhunts_ai") {
    console.error(`[${tag}] cannot quote own tweet — skipping`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "self_quote_blocked", cycle });
    return 1;
  }
  if (!quoteText) {
    console.error(`[${tag}] quote text is empty`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "quote_text_empty", cycle });
    return 1;
  }
  if (quoteText.length > 280) { console.error(`[${tag}] commentary too long (${quoteText.length})`); return 1; }
  const vfErrors = voiceFilter.check(quoteText);
  if (vfErrors.length) {
    console.error(`[${tag}] voice_filter rejected: ${vfErrors.join("; ")}`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "voice_filter", cycle });
    return 1;
  }
  console.log(`[${tag}] quoting: ${sourceUrl} (${quoteText.length} chars)`);

  const x = await makeEngine(tag, attemptFile, "quote", cycle);
  if (!x) return 1;

  let res;
  try {
    res = await x.quote(sourceUrl, quoteText, { dryRun: DRY_RUN, skipIfMentions: OWN_HANDLES });
  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    clearFile(resultFile);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "exception", error: err.message, source_url: sourceUrl, cycle });
    return 1;
  }

  if (res.dryRun) { writeAttempt(attemptFile, { kind: "quote", outcome: "dry_run", source_url: sourceUrl, cycle }); return 0; }
  if (!res.posted) {
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: res.reason || "post_failed", source_url: sourceUrl, cycle });
    return 1;
  }

  const quoteUrl = res.url || "posted";
  if (quoteUrl === "posted") fs.writeFileSync(resultFile, "posted\n");
  else writeResult(resultFile, quoteUrl);
  writeAttempt(attemptFile, { kind: "quote", outcome: "confirmed", confirmed_url: quoteUrl, source_url: sourceUrl, backend: "helmstack", cycle });
  logQuote({ content: quoteText, source_url: sourceUrl, tweet_url: quoteUrl, cycle });
  await x.c.navigate(x.tab, "https://x.com/home").catch(() => {});
  return 0;
}

module.exports = { runTweet, runQuote };
