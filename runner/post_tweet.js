#!/usr/bin/env node
/**
 * runner/post_tweet.js — post tweet from state/tweet_draft.txt via CDP
 *
 * Reads tweet text from state/tweet_draft.txt and posts it to X.com
 * via Playwright CDP (connects to existing Chrome on port 18801).
 * Prints the new tweet URL to stdout on success.
 *
 * Usage: node post_tweet.js
 * Exit 0 = posted, exit 1 = failed
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser, getXPage } = require("./cdp");

const { logTweet } = require("./posts_log");

const ROOT       = path.resolve(__dirname, "..");
const DRAFT_FILE = path.join(ROOT, "state", "tweet_draft.txt");

// X.com selectors (as of 2025)
const COMPOSE_BOX   = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON   = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
const POST_CONFIRM  = '[data-testid="tweetButton"]';  // final confirm in some flows

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  // Read draft
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error("[post_tweet] no tweet_draft.txt found — skipping");
    process.exit(1);
  }
  const tweetText = fs.readFileSync(DRAFT_FILE, "utf-8").trim();
  if (!tweetText) {
    console.error("[post_tweet] tweet_draft.txt is empty — skipping");
    process.exit(1);
  }
  console.log(`[post_tweet] posting (${tweetText.length} chars): ${tweetText.slice(0, 80)}...`);

  // Connect to existing Chrome
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`[post_tweet] could not connect to Chrome: ${err.message}`);
    process.exit(1);
  }

  const page = await getXPage(browser);

  try {
    // Navigate to home (inline compose box — more stable than /compose/post modal)
    console.log("[post_tweet] navigating to x.com/home...");
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await sleep(2_000);

    // Wait for compose box
    console.log("[post_tweet] waiting for compose box...");
    await page.waitForSelector(COMPOSE_BOX, { timeout: 15_000 });
    await sleep(500);

    // Click + focus via evaluate (page.focus() and page.click() hang on this Chrome/puppeteer combo)
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, COMPOSE_BOX);
    await page.evaluate((sel) => {
      document.querySelector(sel)?.focus();
    }, COMPOSE_BOX);
    await sleep(2_000); // wait for React editor to fully initialise before inserting text

    // Insert via execCommand — most reliable for React contenteditable (no clipboard perms needed)
    console.log("[post_tweet] inserting tweet via execCommand...");
    await page.evaluate((text, sel) => {
      const el = document.querySelector(sel);
      if (el) { el.focus(); document.execCommand("insertText", false, text); }
    }, tweetText, COMPOSE_BOX);
    await sleep(1_500);

    // Verify text was inserted correctly — retry with keyboard fallback if truncated
    const insertedText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.trim() : "";
    }, COMPOSE_BOX);
    const expectedLen = tweetText.length;
    const gotLen = insertedText.length;
    console.log(`[post_tweet] text verification: ${gotLen}/${expectedLen} chars`);

    if (!insertedText || gotLen < expectedLen * 0.8) {
      console.log("[post_tweet] text truncated or missing — retrying with keyboard fallback");
      // Clear and retry with keyboard.type
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
      }, COMPOSE_BOX);
      await sleep(500);
      await page.keyboard.type(tweetText, { delay: 20 });
      await sleep(1_500);

      // Second verification
      const retryText = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : "";
      }, COMPOSE_BOX);
      console.log(`[post_tweet] retry verification: ${retryText.length}/${expectedLen} chars`);

      if (!retryText || retryText.length < expectedLen * 0.5) {
        console.error("[post_tweet] text insertion failed after retry — aborting");
        browser.disconnect();
        process.exit(1);
      }
    }

    // Wait for Post button to be enabled
    console.log("[post_tweet] waiting for Post button...");
    await page.waitForSelector(POST_BUTTON, { timeout: 10_000 });
    await sleep(500);

    // Confirm it's not disabled
    const isDisabled = await page.$eval(POST_BUTTON, el => el.getAttribute("aria-disabled")).catch(() => null);
    if (isDisabled === "true") {
      console.error("[post_tweet] Post button is disabled — text may not have registered");
      browser.disconnect();
      process.exit(1);
    }

    // Click Post (evaluate-based avoids Runtime.callFunctionOn timeout)
    console.log("[post_tweet] clicking Post...");
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, POST_BUTTON);
    await sleep(3_000);

    // Try to get the new tweet URL from address bar first
    const finalUrl = page.url();
    console.log(`[post_tweet] page URL after post: ${finalUrl}`);

    let tweetUrl = null;
    if (/x\.com\/\w+\/status\/\d+/.test(finalUrl)) {
      tweetUrl = finalUrl;
    }

    if (!tweetUrl) {
      if (finalUrl.includes("compose")) {
        console.error("[post_tweet] still on compose page — post may have failed");
        browser.disconnect();
        process.exit(1);
      }
      // Navigate to own profile and grab the first tweet URL to confirm post + capture URL
      console.log("[post_tweet] navigating to profile to confirm post and capture URL...");
      await page.goto("https://x.com/sebastianhunts", { waitUntil: "domcontentloaded", timeout: 20_000 });
      // Retry loop — X SPA may take a few seconds to render the timeline
      for (let attempt = 1; attempt <= 3 && !tweetUrl; attempt++) {
        await sleep(3_000);
        tweetUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="/status/"]'));
          const match = links.find(a => /\/sebastianhunts\/status\/\d+/.test(a.getAttribute("href") || ""));
          if (match) return "https://x.com" + match.getAttribute("href").split("?")[0];
          return null;
        });
        if (!tweetUrl && attempt < 3) {
          console.log(`[post_tweet] URL not found on attempt ${attempt}/3 — waiting...`);
        }
      }
      if (tweetUrl) {
        console.log(`[post_tweet] SUCCESS (confirmed from profile): ${tweetUrl}`);
      } else {
        console.log("[post_tweet] posted — could not confirm URL from profile after 3 attempts");
      }
    } else {
      console.log(`[post_tweet] SUCCESS: ${tweetUrl}`);
    }

    fs.writeFileSync(path.join(ROOT, "state", "tweet_result.txt"), (tweetUrl || "posted") + "\n");

    // Log to posts_log.json — always runs, whether called from run.sh or manually
    logTweet({ content: tweetText, tweet_url: tweetUrl || "posted" });

    // Navigate back to home feed so Chrome is clean for next cycle
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});

  } catch (err) {
    console.error(`[post_tweet] error: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  browser.disconnect();
  process.exit(0);
})();
