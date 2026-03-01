#!/usr/bin/env node
/**
 * runner/post_quote.js — post a quote-tweet from state/quote_draft.txt via CDP
 *
 * File format (state/quote_draft.txt):
 *   Line 1: source tweet URL (https://x.com/username/status/ID)
 *   Lines 2+: quote commentary text (max ~240 chars)
 *
 * Flow: navigate to source tweet → click Retweet icon → click "Quote" →
 *       type commentary → click Post.
 *
 * Exit 0 = posted, exit 1 = failed
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser, getXPage } = require("./cdp");

const ROOT        = path.resolve(__dirname, "..");
const DRAFT_FILE  = path.join(ROOT, "state", "quote_draft.txt");
const RESULT_FILE = path.join(ROOT, "state", "quote_result.txt");

const COMPOSE_BOX  = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON  = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
const RETWEET_BTN  = '[data-testid="retweet"]';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  // ── Read draft ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error("[post_quote] no quote_draft.txt found — skipping");
    process.exit(1);
  }

  const raw   = fs.readFileSync(DRAFT_FILE, "utf-8").trim();
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    console.error("[post_quote] quote_draft.txt needs at least 2 lines (source URL + text)");
    process.exit(1);
  }

  const sourceUrl   = lines[0];
  const quoteText   = lines.slice(1).join(" ").trim();
  if (!sourceUrl.startsWith("https://x.com/") && !sourceUrl.startsWith("https://twitter.com/")) {
    console.error(`[post_quote] invalid source URL: ${sourceUrl}`);
    process.exit(1);
  }
  if (!quoteText) {
    console.error("[post_quote] quote text is empty");
    process.exit(1);
  }

  console.log(`[post_quote] quoting: ${sourceUrl}`);
  console.log(`[post_quote] text (${quoteText.length} chars): ${quoteText.slice(0, 80)}...`);

  // ── Connect to Chrome ───────────────────────────────────────────────────────
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`[post_quote] could not connect to Chrome: ${err.message}`);
    process.exit(1);
  }

  const page = await getXPage(browser);

  try {
    // ── Navigate to source tweet ──────────────────────────────────────────────
    console.log(`[post_quote] navigating to source tweet...`);
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(3_000);

    // ── Click the Retweet/Repost icon ─────────────────────────────────────────
    console.log("[post_quote] clicking Retweet icon...");
    await page.waitForSelector(RETWEET_BTN, { timeout: 15_000 });
    await sleep(500);
    await page.click(RETWEET_BTN);
    await sleep(1_200);

    // ── Click "Quote" in the dropdown ─────────────────────────────────────────
    // Wait for either the quoteTweet testid or any menuitem with "Quote" text
    console.log("[post_quote] clicking Quote option...");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="quoteTweet"]') ||
            [...document.querySelectorAll('[role="menuitem"]')].some(el => /^quote$/i.test(el.textContent.trim())),
      { timeout: 8_000 }
    );
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="quoteTweet"]') ||
        [...document.querySelectorAll('[role="menuitem"]')].find(el => /^quote$/i.test(el.textContent.trim()));
      if (el) { el.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error("Quote option not found in dropdown");
    await sleep(2_000);

    // ── Type commentary in compose box ────────────────────────────────────────
    console.log("[post_quote] waiting for compose box...");
    await page.waitForSelector(COMPOSE_BOX, { timeout: 15_000 });
    await sleep(500);
    await page.click(COMPOSE_BOX);
    await sleep(300);

    console.log("[post_quote] typing quote text...");
    await page.keyboard.type(quoteText, { delay: 25 });
    await sleep(1_000);

    // ── Post ──────────────────────────────────────────────────────────────────
    console.log("[post_quote] waiting for Post button...");
    await page.waitForSelector(POST_BUTTON, { timeout: 10_000 });
    await sleep(500);

    const isDisabled = await page.$eval(POST_BUTTON, el => el.getAttribute("aria-disabled")).catch(() => null);
    if (isDisabled === "true") {
      console.error("[post_quote] Post button disabled — text may not have registered");
      browser.disconnect();
      process.exit(1);
    }

    console.log("[post_quote] clicking Post...");
    await page.click(POST_BUTTON);
    await sleep(3_500);

    // ── Capture URL ───────────────────────────────────────────────────────────
    const finalUrl = page.url();
    let quoteUrl = null;
    if (/x\.com\/\w+\/status\/\d+/.test(finalUrl)) {
      quoteUrl = finalUrl;
    } else {
      await sleep(3_000);
      const u2 = page.url();
      if (/x\.com\/\w+\/status\/\d+/.test(u2)) quoteUrl = u2;
    }

    if (quoteUrl) {
      console.log(`[post_quote] SUCCESS: ${quoteUrl}`);
      fs.writeFileSync(RESULT_FILE, quoteUrl + "\n");
    } else if (!finalUrl.includes("compose")) {
      console.log("[post_quote] posted (URL not captured)");
      fs.writeFileSync(RESULT_FILE, "posted\n");
    } else {
      console.error("[post_quote] still on compose page — post may have failed");
      browser.disconnect();
      process.exit(1);
    }

    // Navigate to home feed for next cycle
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});

  } catch (err) {
    console.error(`[post_quote] error: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  browser.disconnect();
  process.exit(0);
})();
