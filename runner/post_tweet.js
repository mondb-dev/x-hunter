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
const {
  captureComposeDiagnostics,
  HANDLE,
  clearFile,
  isConfirmedStatusUrl,
  writeAttempt,
  writeResult,
} = require("./post_result");
const voiceFilter = require("./lib/voice_filter");

const ROOT       = path.resolve(__dirname, "..");
const DRAFT_FILE = path.join(ROOT, "state", "tweet_draft.txt");
const RESULT_FILE = path.join(ROOT, "state", "tweet_result.txt");
const ATTEMPT_FILE = path.join(ROOT, "state", "tweet_attempt.json");
const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;

// X.com selectors (as of 2025)
const COMPOSE_BOX   = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON   = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
const POST_CONFIRM  = '[data-testid="tweetButton"]';  // final confirm in some flows

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Random delay between min and max ms — mimics human timing variance */
async function humanDelay(minMs, maxMs) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return sleep(ms);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function confirmFromProfile(page, expectedText, attempts = 4, delayMs = 3_000) {
  const needle = normalizeText(expectedText).slice(0, 80);
  await page.goto(`https://x.com/${HANDLE}`, { waitUntil: "domcontentloaded", timeout: 90_000 });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delayMs);
    const match = await page.evaluate(({ expectedNeedle, handle }) => {
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const articles = Array.from(document.querySelectorAll("article")).slice(0, 12);
      for (const article of articles) {
        const text = norm(article.innerText);
        if (!text || !text.includes(expectedNeedle)) continue;
        const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map(a => a.getAttribute("href") || "");
        const href = links.find(href =>
          new RegExp(`/${handle}/status/\\d+`, "i").test(href) &&
          !/\/analytics/i.test(href)
        );
        if (href) return `https://x.com${href.split("?")[0]}`;
      }
      return null;
    }, { expectedNeedle: needle, handle: HANDLE });

    if (isConfirmedStatusUrl(match)) return match;
    if (attempt < attempts) {
      console.log(`[post_tweet] profile confirmation miss ${attempt}/${attempts} — waiting...`);
    }
  }

  return null;
}

(async () => {
  clearFile(RESULT_FILE);

  // Read draft
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error("[post_tweet] no tweet_draft.txt found — skipping");
    writeAttempt(ATTEMPT_FILE, {
      kind: "tweet",
      outcome: "failed",
      reason: "draft_missing",
      cycle: CYCLE,
    });
    process.exit(1);
  }
  const tweetText = fs.readFileSync(DRAFT_FILE, "utf-8").trim();
  if (!tweetText) {
    console.error("[post_tweet] tweet_draft.txt is empty — skipping");
    writeAttempt(ATTEMPT_FILE, {
      kind: "tweet",
      outcome: "failed",
      reason: "draft_empty",
      cycle: CYCLE,
    });
    process.exit(1);
  }
  const vfErrors = voiceFilter.check(tweetText);
  if (vfErrors.length > 0) {
    console.error(`[post_tweet] voice_filter rejected draft: ${vfErrors.join("; ")}`);
    writeAttempt(ATTEMPT_FILE, { kind: "tweet", outcome: "failed", reason: "voice_filter", cycle: CYCLE });
    process.exit(1);
  }
  console.log(`[post_tweet] posting (${tweetText.length} chars): ${tweetText.slice(0, 80)}...`);

  // Connect to existing Chrome
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`[post_tweet] could not connect to Chrome: ${err.message}`);
    writeAttempt(ATTEMPT_FILE, {
      kind: "tweet",
      outcome: "failed",
      reason: "cdp_connect_failed",
      error: err.message,
      cycle: CYCLE,
    });
    process.exit(1);
  }

  const page = await getXPage(browser);

  try {
    // Override UA to avoid HeadlessChrome detection
    const client = await page.createCDPSession();
    await client.send("Network.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.80 Safari/537.36",
    });
    await client.detach();

    // Navigate to home (inline compose box — more stable than /compose/post modal)
    console.log("[post_tweet] navigating to x.com/home...");
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await humanDelay(2_500, 5_000); // human-like pause after page load

    // Wait for compose box
    console.log("[post_tweet] waiting for compose box...");
    await page.waitForSelector(COMPOSE_BOX, { timeout: 15_000 });
    await humanDelay(500, 1_500);

    // Click + focus via evaluate (page.focus() and page.click() hang on this Chrome/puppeteer combo)
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, COMPOSE_BOX);
    await page.evaluate((sel) => {
      document.querySelector(sel)?.focus();
    }, COMPOSE_BOX);
    await humanDelay(2_000, 4_000); // wait for React editor to fully initialise before inserting text

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

    if (!insertedText || gotLen < expectedLen * 0.95) {
      console.log("[post_tweet] text truncated or missing — retrying with keyboard fallback");
      // Clear compose box completely
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
      }, COMPOSE_BOX);
      await sleep(1_000);

      // Verify box is actually empty before retyping
      const clearedText = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : "";
      }, COMPOSE_BOX);
      if (clearedText.length > 0) {
        console.log(`[post_tweet] box not fully cleared (${clearedText.length} chars remain) — clearing again`);
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) { el.innerHTML = ""; }
        }, COMPOSE_BOX);
        await sleep(500);
      }

      // Re-click and re-focus to ensure cursor is at position 0
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.click(); el.focus(); }
      }, COMPOSE_BOX);
      await sleep(1_000);

      await page.keyboard.type(tweetText, { delay: 20 });
      await sleep(1_500);

      // Second verification — stricter: check length AND first 20 chars match
      const retryText = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : "";
      }, COMPOSE_BOX);
      const retryLen = retryText.length;
      const firstCharsMatch = retryText.substring(0, 20) === tweetText.substring(0, 20);
      console.log(`[post_tweet] retry verification: ${retryLen}/${expectedLen} chars, first-20-match: ${firstCharsMatch}`);

      if (!retryText || retryLen < expectedLen * 0.98 || !firstCharsMatch) {
        console.error(`[post_tweet] text insertion failed after retry — got "${retryText.substring(0, 40)}..." — aborting`);
        browser.disconnect();
        process.exit(1);
      }
    }

    // Wait for Post button to be enabled
    console.log("[post_tweet] waiting for Post button...");
    await page.waitForSelector(POST_BUTTON, { timeout: 10_000 });
    await humanDelay(500, 1_500);

    // Confirm it's not disabled
    const isDisabled = await page.$eval(POST_BUTTON, el => el.getAttribute("aria-disabled")).catch(() => null);
    if (isDisabled === "true") {
      console.error("[post_tweet] Post button is disabled — text may not have registered");
      browser.disconnect();
      process.exit(1);
    }

    // Check for anti-automation toast before posting
    const prePostToast = await page.evaluate(() => {
      const toasts = Array.from(document.querySelectorAll('[data-testid="toast"], [role="alert"]'));
      return toasts.map(t => t.innerText).find(t => /automated|spam/i.test(t)) || null;
    }).catch(() => null);
    if (prePostToast) {
      console.error(`[post_tweet] anti-automation toast detected before posting: ${prePostToast}`);
      writeAttempt(ATTEMPT_FILE, {
        kind: "tweet",
        outcome: "failed",
        reason: "anti_automation_block",
        stage: "before_post_click",
        toast: prePostToast,
        cycle: CYCLE,
      });
      browser.disconnect();
      process.exit(1);
    }

    // Click Post (evaluate-based avoids Runtime.callFunctionOn timeout)
    await humanDelay(1_500, 3_500); // human pause before posting
    console.log("[post_tweet] clicking Post...");
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, POST_BUTTON);
    await sleep(5_000); // longer wait for X to process the post

    // Try to get the new tweet URL from address bar first
    const finalUrl = page.url();
    console.log(`[post_tweet] page URL after post: ${finalUrl}`);

    let tweetUrl = null;
    if (isConfirmedStatusUrl(finalUrl)) {
      tweetUrl = finalUrl;
    }

    if (!tweetUrl) {
      // Detect X graduated-access interstitial — the tweet may have gone through
      if (finalUrl.includes("graduated-access")) {
        console.log("[post_tweet] graduated-access interstitial detected — waiting 10s before checking profile...");
        await sleep(10_000);
        tweetUrl = await confirmFromProfile(page, tweetText, 4, 3_000);
        if (tweetUrl) {
          console.log(`[post_tweet] tweet confirmed despite graduated-access: ${tweetUrl}`);
        } else {
          console.error("[post_tweet] graduated-access blocked the post — X rate-limiting");
          writeAttempt(ATTEMPT_FILE, {
            kind: "tweet",
            outcome: "failed",
            reason: "rate_limited",
            stage: "after_post_click",
            final_url: finalUrl,
            cycle: CYCLE,
          });
          browser.disconnect();
          process.exit(1);
        }
      } else if (finalUrl.includes("compose")) {
        console.error("[post_tweet] still on compose page — post may have failed");
        const composeDiagnostics = await captureComposeDiagnostics(page, {
          composeSelector: COMPOSE_BOX,
          postButtonSelector: POST_BUTTON,
        });
        console.log(`[post_tweet] compose diagnostics: ${JSON.stringify(composeDiagnostics)}`);
        writeAttempt(ATTEMPT_FILE, {
          kind: "tweet",
          outcome: "failed",
          reason: "compose_stuck",
          stage: "after_post_click",
          final_url: finalUrl,
          compose_diagnostics: composeDiagnostics,
          cycle: CYCLE,
        });
        browser.disconnect();
        process.exit(1);
      } else {
        // Check for anti-automation toast after clicking Post
        const postToast = await page.evaluate(() => {
          const toasts = Array.from(document.querySelectorAll('[data-testid="toast"], [role="alert"]'));
          return toasts.map(t => t.innerText).find(t => /automated|spam/i.test(t)) || null;
        }).catch(() => null);
        if (postToast) {
          console.error(`[post_tweet] anti-automation toast after post: ${postToast}`);
          writeAttempt(ATTEMPT_FILE, {
            kind: "tweet",
            outcome: "failed",
            reason: "anti_automation_block",
            stage: "after_post_click",
            toast: postToast,
            final_url: finalUrl,
            cycle: CYCLE,
          });
          browser.disconnect();
          process.exit(1);
        }

        // Navigate to own profile and grab the first tweet URL to confirm post + capture URL
        console.log("[post_tweet] navigating to profile to confirm post and capture URL...");
        tweetUrl = await confirmFromProfile(page, tweetText, 5, 4_000);
        if (tweetUrl) {
          console.log(`[post_tweet] SUCCESS (confirmed from profile): ${tweetUrl}`);
        } else {
          // If we landed on /home (not /compose), the tweet likely posted but profile confirm timed out
          if (finalUrl.includes("/home")) {
            console.log("[post_tweet] probable success — clicked Post and returned to /home, but could not confirm URL");
            tweetUrl = "posted";
          } else {
            console.error("[post_tweet] could not confirm tweet from profile after 5 attempts");
            writeAttempt(ATTEMPT_FILE, {
              kind: "tweet",
              outcome: "failed",
              reason: "profile_confirm_timeout",
              stage: "profile_confirm",
              final_url: finalUrl,
              cycle: CYCLE,
            });
            browser.disconnect();
            process.exit(1);
          }
        }
      }
    } else {
      console.log(`[post_tweet] SUCCESS: ${tweetUrl}`);
    }

    writeResult(RESULT_FILE, tweetUrl);
    writeAttempt(ATTEMPT_FILE, {
      kind: "tweet",
      outcome: "confirmed",
      confirmed_url: tweetUrl,
      final_url: finalUrl,
      cycle: CYCLE,
    });

    logTweet({ content: tweetText, tweet_url: tweetUrl, cycle: CYCLE });

    // Navigate back to home feed so Chrome is clean for next cycle
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});

  } catch (err) {
    console.error(`[post_tweet] error: ${err.message}`);
    clearFile(RESULT_FILE);
    writeAttempt(ATTEMPT_FILE, {
      kind: "tweet",
      outcome: "failed",
      reason: "exception",
      error: err.message,
      cycle: CYCLE,
    });
    browser.disconnect();
    process.exit(1);
  }

  browser.disconnect();
  process.exit(0);
})();
