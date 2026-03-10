#!/usr/bin/env node
/**
 * runner/post_quote.js — post a quote-tweet from state/quote_draft.txt via CDP
 *
 * File format (state/quote_draft.txt):
 *   Line 1: source tweet URL (https://x.com/username/status/ID)
 *   Lines 2+: quote commentary text (max ~240 chars)
 *
 * Flow: navigate to source tweet → click Retweet → click Quote → insert
 *       commentary via execCommand → click Post.
 *       X handles the embed automatically; we only insert the commentary text.
 *
 * Exit 0 = posted, exit 1 = failed
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser, getXPage } = require("./cdp");

const { logQuote } = require("./posts_log");

const ROOT        = path.resolve(__dirname, "..");
const DRAFT_FILE  = path.join(ROOT, "state", "quote_draft.txt");
const RESULT_FILE = path.join(ROOT, "state", "quote_result.txt");

const COMPOSE_BOX = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';

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

  const sourceUrl = lines[0];
  const quoteText = lines.slice(1).join(" ").trim();
  if (!sourceUrl.startsWith("https://x.com/") && !sourceUrl.startsWith("https://twitter.com/")) {
    console.error(`[post_quote] invalid source URL: ${sourceUrl}`);
    process.exit(1);
  }
  if (!quoteText) {
    console.error("[post_quote] quote text is empty");
    process.exit(1);
  }

  // In Quote flow, the embed doesn't count against the 280 char limit
  console.log(`[post_quote] quoting: ${sourceUrl}`);
  console.log(`[post_quote] text (${quoteText.length} chars): ${quoteText.slice(0, 80)}...`);

  if (quoteText.length > 280) {
    console.error(`[post_quote] commentary too long (${quoteText.length} > 280 chars)`);
    process.exit(1);
  }

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
    // Navigate directly to the source tweet
    console.log(`[post_quote] navigating to source tweet: ${sourceUrl}`);
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // Wait for retweet button to appear (up to 10s) rather than fixed sleep
    try {
      await page.waitForSelector("[data-testid='retweet']", { timeout: 10_000 });
    } catch {
      await sleep(3_000); // fallback
    }

    // Click the Retweet button on the tweet
    console.log("[post_quote] clicking Retweet button...");
    const retweeted = await page.evaluate(() => {
      const btn = document.querySelector("[data-testid='retweet']");
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!retweeted) throw new Error("Retweet button not found");
    await sleep(800);

    // Click "Quote" in the retweet menu
    console.log("[post_quote] clicking Quote option...");
    const quoted = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("[role='menuitem']"));
      const q = items.find(i => i.innerText?.trim().toLowerCase() === "quote");
      if (q) { q.click(); return true; }
      return false;
    });
    if (!quoted) throw new Error("Quote menu item not found");
    await sleep(1_200);

    // Wait for the quote compose box to appear
    console.log("[post_quote] waiting for compose box...");
    await page.waitForSelector(COMPOSE_BOX, { timeout: 10_000 });
    await sleep(600);

    // Focus the compose box
    await page.evaluate((sel) => {
      document.querySelector(sel)?.click();
      document.querySelector(sel)?.focus();
    }, COMPOSE_BOX);
    await sleep(2_000); // wait for React editor to fully initialise before inserting text

    // Insert via execCommand — most reliable for React contenteditable (no clipboard perms needed)
    console.log("[post_quote] inserting commentary via execCommand...");
    await page.evaluate((text, sel) => {
      const el = document.querySelector(sel);
      if (el) { el.focus(); document.execCommand("insertText", false, text); }
    }, quoteText, COMPOSE_BOX);
    await sleep(1_500);

    // Wait for Post button to be enabled
    console.log("[post_quote] waiting for Post button...");
    await page.waitForSelector(POST_BUTTON, { timeout: 10_000 });
    await sleep(500);

    const isDisabled = await page.$eval(POST_BUTTON, el => el.getAttribute("aria-disabled")).catch(() => null);
    if (isDisabled === "true") {
      console.error("[post_quote] Post button disabled — text may not have registered");
      browser.disconnect();
      process.exit(1);
    }

    // Click Post
    console.log("[post_quote] clicking Post...");
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, POST_BUTTON);
    await sleep(3_500);

    // Capture result — home compose stays on /home after post (no status redirect)
    const finalUrl = page.url();
    let quoteUrl = null;
    if (/x\.com\/\w+\/status\/\d+/.test(finalUrl)) {
      quoteUrl = finalUrl;
    } else {
      await sleep(2_000);
      const u2 = page.url();
      if (/x\.com\/\w+\/status\/\d+/.test(u2)) quoteUrl = u2;
    }

    if (quoteUrl) {
      console.log(`[post_quote] SUCCESS: ${quoteUrl}`);
      fs.writeFileSync(RESULT_FILE, quoteUrl + "\n");
    } else {
      console.log("[post_quote] posted (URL not captured — home compose does not redirect)");
      fs.writeFileSync(RESULT_FILE, "posted\n");
    }

    // Log to posts_log.json — always runs, whether called from run.sh or manually
    logQuote({ source_url: sourceUrl, content: quoteText, tweet_url: quoteUrl || "" });

  } catch (err) {
    console.error(`[post_quote] error: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  browser.disconnect();
  process.exit(0);
})();
