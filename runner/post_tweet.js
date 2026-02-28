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
    // Navigate to compose page
    console.log("[post_tweet] navigating to x.com/compose/post...");
    await page.goto("https://x.com/compose/post", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await sleep(2_000);

    // Wait for compose box
    console.log("[post_tweet] waiting for compose box...");
    await page.waitForSelector(COMPOSE_BOX, { timeout: 15_000 });
    await sleep(500);

    // Click to focus
    await page.click(COMPOSE_BOX);
    await sleep(300);

    // Type tweet text character by character (triggers React onChange)
    console.log("[post_tweet] typing tweet...");
    await page.keyboard.type(tweetText, { delay: 30 });
    await sleep(1_000);

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

    // Click Post
    console.log("[post_tweet] clicking Post...");
    await page.click(POST_BUTTON);
    await sleep(3_000);

    // Try to get the new tweet URL from address bar
    const finalUrl = page.url();
    console.log(`[post_tweet] page URL after post: ${finalUrl}`);

    let tweetUrl = null;
    if (/x\.com\/\w+\/status\/\d+/.test(finalUrl)) {
      tweetUrl = finalUrl;
    } else {
      // Wait a bit and check again
      await sleep(3_000);
      const u2 = page.url();
      if (/x\.com\/\w+\/status\/\d+/.test(u2)) {
        tweetUrl = u2;
      }
    }

    if (tweetUrl) {
      console.log(`[post_tweet] SUCCESS: ${tweetUrl}`);
      // Write URL to a result file for run.sh to read
      fs.writeFileSync(path.join(ROOT, "state", "tweet_result.txt"), tweetUrl + "\n");
    } else {
      // Posted but URL not captured — still a success if page moved away from compose
      if (!finalUrl.includes("compose")) {
        console.log("[post_tweet] posted (URL not captured — no status redirect)");
        fs.writeFileSync(path.join(ROOT, "state", "tweet_result.txt"), "posted\n");
      } else {
        console.error("[post_tweet] still on compose page — post may have failed");
        browser.disconnect();
        process.exit(1);
      }
    }

    // Navigate back to home feed so Chrome is clean for next cycle
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});

  } catch (err) {
    console.error(`[post_tweet] error: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  await browser.close();
  process.exit(0);
})();
