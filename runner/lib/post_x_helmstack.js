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

// Opt-in unified outbox for X (default OFF — the file/result/attempt contract and
// cycle metrics are untouched when off). When OUTBOX_X=1, each tweet/quote is
// recorded in lib/outbox for a unified ledger + content-level DEDUP: identical
// text queued or posted in the last 7 days is skipped rather than reposted.
const OUTBOX_X = process.env.OUTBOX_X === "1";
const outbox = OUTBOX_X ? require("./outbox") : null;

/**
 * Record an outbound X item and check for a duplicate. Returns {id, deduped}
 * (or null when OUTBOX_X is off / on error — callers then behave as before).
 */
function outboxEnqueue(kind, text, meta) {
  if (!OUTBOX_X) return null;
  try { return outbox.enqueue({ channel: "x", kind, text, meta }); } catch { return null; }
}
function outboxMark(id, outcome, extra) {
  if (!OUTBOX_X || !id) return;
  try {
    if (outcome === "posted") outbox.markPosted(id, { url: extra || null });
    else if (outcome === "rejected") outbox.markRejected(id, extra || "");
    else outbox.markFailed(id, extra || "");
  } catch { /* ledger errors never affect posting */ }
}

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
  const ob = outboxEnqueue("tweet", tweetText, { cycle });
  if (ob && ob.deduped) {
    console.log(`[${tag}] identical tweet already queued/posted (outbox #${ob.id}) — skipping duplicate`);
    writeAttempt(attemptFile, { kind: "tweet", outcome: "skipped", reason: "duplicate", cycle });
    return 0;
  }
  console.log(`[${tag}] posting (${tweetText.length} chars): ${tweetText.slice(0, 80)}...`);

  const x = await makeEngine(tag, attemptFile, "tweet", cycle);
  if (!x) { outboxMark(ob && ob.id, "failed", "helmstack_connect_failed"); return 1; }

  let res;
  try {
    res = await x.post(tweetText, { dryRun: DRY_RUN });
  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    clearFile(resultFile);
    outboxMark(ob && ob.id, "failed", `exception: ${err.message}`);
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: "exception", error: err.message, cycle });
    return 1;
  }

  if (res.dryRun) { outboxMark(ob && ob.id, "failed", "dry_run"); writeAttempt(attemptFile, { kind: "tweet", outcome: "dry_run", cycle }); return 0; }
  if (!res.posted) {
    outboxMark(ob && ob.id, "failed", res.reason || "post_failed");
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: res.reason || "post_failed", cycle });
    return 1;
  }

  const tweetUrl = res.url && isConfirmedStatusUrl(res.url) ? res.url : "posted";
  if (tweetUrl === "posted") fs.writeFileSync(resultFile, "posted\n");
  else writeResult(resultFile, tweetUrl);
  outboxMark(ob && ob.id, "posted", tweetUrl === "posted" ? null : tweetUrl);
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
  const ob = outboxEnqueue("quote", quoteText, { cycle, sourceUrl });
  if (ob && ob.deduped) {
    console.log(`[${tag}] identical quote already queued/posted (outbox #${ob.id}) — skipping duplicate`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "skipped", reason: "duplicate", source_url: sourceUrl, cycle });
    return 0;
  }
  console.log(`[${tag}] quoting: ${sourceUrl} (${quoteText.length} chars)`);

  const x = await makeEngine(tag, attemptFile, "quote", cycle);
  if (!x) { outboxMark(ob && ob.id, "failed", "helmstack_connect_failed"); return 1; }

  let res;
  try {
    res = await x.quote(sourceUrl, quoteText, { dryRun: DRY_RUN, skipIfMentions: OWN_HANDLES });
  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    clearFile(resultFile);
    outboxMark(ob && ob.id, "failed", `exception: ${err.message}`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "exception", error: err.message, source_url: sourceUrl, cycle });
    return 1;
  }

  if (res.dryRun) { outboxMark(ob && ob.id, "failed", "dry_run"); writeAttempt(attemptFile, { kind: "quote", outcome: "dry_run", source_url: sourceUrl, cycle }); return 0; }
  if (!res.posted) {
    outboxMark(ob && ob.id, "failed", res.reason || "post_failed");
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: res.reason || "post_failed", source_url: sourceUrl, cycle });
    return 1;
  }

  const quoteUrl = res.url || "posted";
  if (quoteUrl === "posted") fs.writeFileSync(resultFile, "posted\n");
  else writeResult(resultFile, quoteUrl);
  outboxMark(ob && ob.id, "posted", quoteUrl === "posted" ? null : quoteUrl);
  writeAttempt(attemptFile, { kind: "quote", outcome: "confirmed", confirmed_url: quoteUrl, source_url: sourceUrl, backend: "helmstack", cycle });
  logQuote({ content: quoteText, source_url: sourceUrl, tweet_url: quoteUrl, cycle });
  await x.c.navigate(x.tab, "https://x.com/home").catch(() => {});
  return 0;
}

// ── runThread ─────────────────────────────────────────────────────────────────
// Posts an already-gated ordered list of tweets as a self-thread via the engine.
// Gating (voice_filter + coherence) stays in post_thread.js; this only posts.
// Returns { ok, tweet1Url, urls } — tweet1Url null means tweet1 itself failed.
async function runThread(tweets, { cycle } = {}) {
  const tag = "post_thread.hs";
  if (!Array.isArray(tweets) || !tweets.length) return { ok: false, reason: "no_tweets" };

  const x = await makeEngine(tag, null, "thread", cycle);
  if (!x) return { ok: false, reason: "helmstack_connect_failed" };

  let res;
  try {
    res = await x.postThread(tweets, { dryRun: DRY_RUN });
  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    return { ok: false, reason: "exception", error: err.message };
  }

  if (res.dryRun) { console.log(`[${tag}] dry run — not posted`); return { ok: false, dryRun: true }; }
  if (!res.ok) { console.error(`[${tag}] thread failed: ${res.reason}`); return { ok: false, reason: res.reason }; }

  const urls = res.urls || [];
  const tweet1Url = urls[0] && isConfirmedStatusUrl(urls[0]) ? urls[0] : (urls[0] || null);
  if (!tweet1Url) return { ok: false, reason: "tweet1_unconfirmed" };

  // Log tweet1 + each confirmed reply, mirroring the CDP path's posts_log shape.
  logTweet({ type: "thread", content: tweets[0], tweet_url: tweet1Url, cycle });
  let replyTo = tweet1Url;
  for (let i = 1; i < tweets.length; i++) {
    const u = urls[i];
    if (u) { logTweet({ type: "thread_reply", content: tweets[i], tweet_url: u, reply_to: replyTo, cycle }); replyTo = u; }
    else console.log(`[${tag}] tweet${i + 1} not confirmed`);
  }
  await x.c.navigate(x.tab, "https://x.com/home").catch(() => {});
  return { ok: true, tweet1Url, urls };
}

module.exports = { runTweet, runQuote, runThread };
