#!/usr/bin/env node
/**
 * runner/post_and_pin.js — post a tweet and pin it to the profile.
 *
 * Usage: node runner/post_and_pin.js "tweet text"
 *   Or:  node runner/post_and_pin.js  (reads from stdin if no arg)
 */
"use strict";

const fs  = require("fs");
const path = require("path");
const { connectBrowser } = require("./cdp");

const ROOT        = path.resolve(__dirname, "..");
const COMPOSE_BOX = "[data-testid='tweetTextarea_0']";
const POST_BUTTON = "[data-testid='tweetButtonInline']";

if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const tweetText = process.argv[2];
  if (!tweetText) { console.error("Usage: node post_and_pin.js \"tweet text\""); process.exit(1); }
  console.log(`[post_pin] tweet (${tweetText.length} chars): ${tweetText.slice(0, 80)}...`);

  // HelmStack path (default) — post via the engine, then pin by URL.
  if ((process.env.POST_BACKEND || "").toLowerCase() === "helmstack") {
    const { HelmStackClient, X } = require("../tools/helmstack-social/src");
    const { HANDLE } = require("./post_result");
    const dry = process.env.HELMSTACK_DRY_RUN === "1";
    const x = new X(new HelmStackClient(), { ownHandle: HANDLE, log: (m) => console.log(`[post_pin.hs] ${m}`) });
    await x.c.health();
    await x.ensureTab();
    const posted = await x.post(tweetText, { dryRun: dry });
    if (dry) { console.log("[post_pin] dry run — not posted/pinned"); process.exit(0); }
    if (!posted.posted || !posted.url) { console.error(`[post_pin] post failed or URL uncaptured: ${posted.reason || "no_url"}`); process.exit(1); }
    console.log(`[post_pin] posted: ${posted.url}`);
    const pinned = await x.pinTweet(posted.url);
    await x.c.navigate(x.tab, "https://x.com/home").catch(() => {});
    console.log(`[post_pin] ${pinned.ok ? "pinned" : `pin failed: ${pinned.reason}`}`);
    process.exit(pinned.ok ? 0 : 1);
  }

  const browser = await connectBrowser();
  const page    = await browser.newPage();

  // ── Post the tweet ─────────────────────────────────────────────────────────
  console.log("[post_pin] navigating to x.com/home...");
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(2_000);

  await page.waitForSelector(COMPOSE_BOX, { timeout: 15_000 });
  await sleep(600);

  await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, COMPOSE_BOX);
  await page.evaluate((sel) => { document.querySelector(sel)?.focus(); }, COMPOSE_BOX);
  await sleep(600);

  // Clear any leftover draft, then insert (atomic). Without clearing, stale
  // composer text causes our tweet to be spliced into it.
  await page.evaluate((text, sel) => {
    const el = document.querySelector(sel);
    if (el) { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); document.execCommand("insertText", false, text); }
  }, tweetText, COMPOSE_BOX);

  await sleep(1_500);
  const pinInserted = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.trim() : "";
  }, COMPOSE_BOX);
  if (pinInserted !== tweetText.trim()) throw new Error(`post_and_pin: compose text mismatch (${pinInserted.length}/${tweetText.length} chars) — aborting to avoid spliced post`);
  await page.waitForSelector(POST_BUTTON, { timeout: 10_000 });
  await sleep(500);

  const isDisabled = await page.$eval(POST_BUTTON, el => el.getAttribute("aria-disabled")).catch(() => null);
  if (isDisabled === "true") throw new Error("Post button disabled — text did not register");

  await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, POST_BUTTON);
  await sleep(4_000);

  // Capture the new tweet URL from the final navigation or from the profile
  let tweetUrl = null;
  const current = page.url();
  if (/x\.com\/\w+\/status\/\d+/.test(current)) tweetUrl = current;

  console.log(`[post_pin] posted — url: ${tweetUrl || "(navigating to profile to find it)"}`);

  // ── Find tweet URL on profile if not captured ─────────────────────────────
  if (!tweetUrl) {
    const username = process.env.X_USERNAME || "SebastianHunts";
    await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await sleep(3_000);
    // Find the first tweet article and extract its link
    tweetUrl = await page.evaluate((fragment) => {
      const arts = Array.from(document.querySelectorAll("article"));
      for (const art of arts) {
        if (art.innerText?.includes(fragment)) {
          const a = art.querySelector("a[href*='/status/']");
          if (a) return "https://x.com" + a.getAttribute("href").split("?")[0];
        }
      }
      return null;
    }, tweetText.slice(0, 30));
  }

  if (!tweetUrl) {
    console.error("[post_pin] could not find tweet URL — cannot pin. Tweet was posted.");
    browser.disconnect();
    process.exit(0);
  }

  console.log(`[post_pin] tweet URL: ${tweetUrl}`);

  // ── Navigate to the tweet and pin it ──────────────────────────────────────
  await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(2_500);

  // Open the three-dot menu on the tweet
  const opened = await page.evaluate(() => {
    const carets = Array.from(document.querySelectorAll("[data-testid='caret']"));
    if (carets.length) { carets[0].click(); return true; }
    return false;
  });

  if (!opened) {
    console.error("[post_pin] could not open tweet menu — pin manually");
    browser.disconnect();
    process.exit(0);
  }

  await sleep(800);

  // Click "Pin to your profile"
  const pinned = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("[role='menuitem']"));
    const pin = items.find(i => i.innerText?.toLowerCase().includes("pin"));
    if (pin) { pin.click(); return true; }
    return false;
  });

  if (!pinned) {
    console.error("[post_pin] 'Pin' menu item not found — check if already pinned or pin manually");
    browser.disconnect();
    process.exit(0);
  }

  await sleep(1_000);

  // Confirm pinning in modal if present
  const confirmed = await page.evaluate(() => {
    const btn = document.querySelector("[data-testid='confirmationSheetConfirm']");
    if (btn) { btn.click(); return true; }
    const all = Array.from(document.querySelectorAll("button"));
    const p = all.find(b => b.innerText?.toLowerCase().includes("pin"));
    if (p) { p.click(); return true; }
    return false;
  });

  await sleep(1_500);
  console.log(`[post_pin] pinned: ${confirmed} — ${tweetUrl}`);
  browser.disconnect();
}

main().catch(err => {
  console.error("[post_pin] fatal:", err.message);
  process.exit(1);
});
