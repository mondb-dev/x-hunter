#!/usr/bin/env node
/**
 * scraper/mentions.js — fast, lightweight mention poller.
 *
 * Captures @mentions far more often than the 5-min collect loop (which still
 * runs as a fallback), and — when it finds something new — triggers a reply
 * run so a mention doesn't wait for the next scheduled reply tick. Uses its own
 * dedicated HelmStack tab (the same pattern collect.js/reply.js use to coexist)
 * and closes it each run. Any failure is non-fatal: it exits 0 so the bash loop
 * keeps going and collect.js keeps capturing.
 *
 * Env:  MENTIONS_TRIGGER_REPLY=0  capture only, don't kick a reply run
 *       HELMSTACK_DRY_RUN=1       never trigger a reply run
 *       X_USERNAME                handle to search mentions for
 */

"use strict";

const path = require("path");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const { HelmStackClient, X } = require("../tools/helmstack-social/src");
const { appendMentionsToReplyQueue } = require("./lib/reply_queue");

const HANDLE        = process.env.X_USERNAME || "SebastianHunts";
const TRIGGER_REPLY = process.env.MENTIONS_TRIGGER_REPLY !== "0";
const dryRun        = process.env.HELMSTACK_DRY_RUN === "1";

async function captureNotifications(x) {
  try {
    const mentions = await x.scrapeMentions({ limit: 20 });
    const n = appendMentionsToReplyQueue(mentions);
    console.log(`[mentions] notifications: ${mentions.length} seen, ${n} new`);
    return n;
  } catch (e) { console.error(`[mentions] notifications failed: ${e.message}`); return 0; }
}

async function captureSearch(x) {
  try {
    const own = HANDLE.toLowerCase();
    const results = await x.searchX(`@${HANDLE}`, { limit: 20, mode: "live" });
    const mentions = (results || []).filter((m) => (m.username || "").toLowerCase() !== own);
    const n = appendMentionsToReplyQueue(mentions);
    console.log(`[mentions] search: ${mentions.length} seen, ${n} new`);
    return n;
  } catch (e) { console.error(`[mentions] search failed: ${e.message}`); return 0; }
}

function triggerReply() {
  try {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [path.join(__dirname, "reply.js")], {
      detached: true, stdio: "ignore", env: { ...process.env },
    });
    child.unref();
    console.log("[mentions] new mentions → triggered a reply run (reply.js dedupes via its run-lock)");
  } catch (e) { console.error(`[mentions] could not trigger reply: ${e.message}`); }
}

(async () => {
  console.log("[mentions] fast poll starting...");
  let x;
  try {
    x = new X(new HelmStackClient(), {
      ownHandle: HANDLE,
      dedicatedTab: true,
      log: (m) => console.log(`[mentions] ${m}`),
    });
    await x.ensureTab();
    if (!(await x.sessionOk())) throw new Error("X session not present (auth_token/ct0 missing)");
  } catch (e) {
    console.error(`[mentions] could not connect to HelmStack: ${e.message} — collect.js still captures each cycle`);
    process.exit(0); // non-fatal: never crash the loop
  }

  let newCount = 0;
  try {
    newCount += await captureNotifications(x);
    newCount += await captureSearch(x);
  } finally {
    if (x) await x.close().catch(() => {});
  }

  console.log(`[mentions] done — ${newCount} new mention(s) queued`);
  if (newCount > 0 && TRIGGER_REPLY && !dryRun) triggerReply();
  process.exit(0);
})();
