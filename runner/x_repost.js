#!/usr/bin/env node
/**
 * runner/x_repost.js — repost (retweet) a tweet by URL via X's CreateRetweet
 * GraphQL API (in-page authed fetch, same machinery as CreateTweet — no UI).
 *
 * Usage:
 *   node runner/x_repost.js https://x.com/user/status/ID [--undo] [--topic <topic>]
 *
 * --undo removes an existing repost (DeleteRetweet). HELMSTACK_DRY_RUN=1 stops
 * after verifying the queryId extraction (nothing is reposted).
 *
 * This is the manual/queue entry point for Item 3's repost action; the
 * autonomous selection + learn-loop layers on top of it.
 */
"use strict";

const { HelmStackClient, X } = require("../tools/helmstack-social/src");
const { HANDLE } = require("./post_result");
const { logRepost } = require("./posts_log");

async function main() {
  const args = process.argv.slice(2);
  const undo = args.includes("--undo");
  const ti = args.indexOf("--topic");
  const topic = ti >= 0 ? args[ti + 1] : null;
  const tweetUrl = args.find((a) => /\/status\/\d+/.test(a));
  if (!tweetUrl) {
    console.error("Usage: node runner/x_repost.js https://x.com/user/status/ID [--undo] [--topic <topic>]");
    process.exit(1);
  }
  const dryRun = process.env.HELMSTACK_DRY_RUN === "1";

  const sourceHandle = (tweetUrl.match(/x\.com\/([^/]+)\/status\//i) || [])[1] || "";
  if (!undo && sourceHandle.toLowerCase() === HANDLE.toLowerCase()) {
    console.error(`[x_repost] refusing to repost own tweet: ${tweetUrl}`);
    process.exit(1);
  }

  const x = new X(new HelmStackClient(), { ownHandle: HANDLE, log: (m) => console.log(`[x_repost.hs] ${m}`) });
  await x.c.health();
  await x.ensureTab();
  if (!(await x.sessionOk())) {
    console.error("[x_repost] X session not logged in");
    process.exit(1);
  }

  const res = undo
    ? await x.unretweet(tweetUrl, { dryRun })
    : await x.retweet(tweetUrl, { dryRun });

  if (res.dryRun) { console.log("[x_repost] dry run complete"); process.exit(0); }
  if (!res.ok) {
    console.error(`[x_repost] ${undo ? "un-repost" : "repost"} failed: ${res.reason}`);
    process.exit(1);
  }
  if (!undo) {
    const srcUrl = tweetUrl.split("?")[0];
    logRepost({ source_url: srcUrl, source_handle: sourceHandle, topic });
    // Amplification learn-loop: tag WHAT we amplified. A bare repost has no own
    // engagement surface, so measurable:false — it records the source for the
    // track record but never sits in the measure queue. Keyed by source URL
    // (a retweet has no own status URL).
    try { require("./lib/amplify_performance").recordAmplification(`repost:${srcUrl}`, { channel: "x", sourceHandle, topic, technique: "repost", sourceUrl: srcUrl, measurable: false }); } catch {}
  }
  console.log(`[x_repost] ${undo ? "un-reposted" : "reposted"}: ${tweetUrl}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[x_repost] fatal:", err.message);
  process.exit(1);
});
