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

/**
 * Poll for a DOM condition every `interval` ms, up to `attempts` times.
 * selectorOrFn: CSS selector string OR a serialisable function returning bool.
 * Throws if all attempts exhausted.
 */
async function poll(page, label, selectorOrFn, { attempts = 10, interval = 1_000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const found = typeof selectorOrFn === "string"
      ? await page.evaluate(sel => !!document.querySelector(sel), selectorOrFn)
      : await page.evaluate(selectorOrFn).catch(() => false);
    if (found) {
      console.log(`[post_quote] ${label} ready (attempt ${i}/${attempts})`);
      return;
    }
    if (i < attempts) {
      console.log(`[post_quote] ${label} not ready — retry ${i}/${attempts} in ${interval}ms`);
      await sleep(interval);
    }
  }
  throw new Error(`${label} not found after ${attempts} attempts`);
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
  // Reject quoting own tweets
  const sourceHandle = (sourceUrl.match(/x\.com\/([^/]+)/) || [])[1] || "";
  if (sourceHandle.toLowerCase() === "sebastianhunts") {
    console.error("[post_quote] cannot quote own tweet — skipping");
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

  // ── Pre-post guard: reject quotes of tweets that mention @SebastianHunts ──
  // Fetches the source tweet page and checks for Sebastian mentions to prevent
  // quoting replies/questions directed at the agent (AGENTS.md §13.6 / HARD SKIP rule)
  const OWN_HANDLES = ["sebastianhunts", "sebastian_hunts"];
  const _guardNeedsCheck = true; // always check — agent prompt is not enough

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

    // Poll for retweet button (up to 15s)
    await poll(page, "retweet button", "[data-testid='retweet']", { attempts: 15, interval: 1_000 });

    // ── Guard: check if source tweet mentions @SebastianHunts ──────────────
    // Scrape the visible tweet text + any "Replying to" header for own-handle mentions
    const mentionsSelf = await page.evaluate((handles) => {
      // Get the main tweet text
      const tweetEl = document.querySelector('[data-testid="tweetText"]');
      const tweetText = (tweetEl?.innerText || "").toLowerCase();
      // Get "Replying to" context if present
      const replyEls = document.querySelectorAll('[data-testid="tweet"] a[href^="/"]');
      const replyText = Array.from(replyEls).map(a => (a.getAttribute("href") || "").toLowerCase()).join(" ");
      // Check both areas for @SebastianHunts mention
      const full = tweetText + " " + replyText;
      return handles.some(h => full.includes(h) || full.includes("@" + h));
    }, OWN_HANDLES).catch(() => false);

    if (mentionsSelf) {
      console.error("[post_quote] source tweet mentions @SebastianHunts — HARD SKIP (never quote mentions of self)");
      browser.disconnect();
      process.exit(1);
    }

    // Click the Retweet button
    console.log("[post_quote] clicking Retweet button...");
    await page.evaluate(() => document.querySelector("[data-testid='retweet']")?.click());

    // Poll for the Quote menu item to appear
    await poll(page, "quote menu item", () => {
      const items = Array.from(document.querySelectorAll("[role='menuitem']"));
      return items.some(i => i.innerText?.trim().toLowerCase() === "quote");
    }, { attempts: 8, interval: 1_000 });

    // Click "Quote"
    console.log("[post_quote] clicking Quote option...");
    const quoted = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("[role='menuitem']"));
      const q = items.find(i => i.innerText?.trim().toLowerCase() === "quote");
      if (q) { q.click(); return true; }
      return false;
    });
    if (!quoted) throw new Error("Quote menu item click failed");

    // Poll for compose box to appear
    await poll(page, "compose box", COMPOSE_BOX, { attempts: 10, interval: 1_000 });

    // Click + focus via evaluate (more reliable for React contenteditable)
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, COMPOSE_BOX);
    await page.evaluate((sel) => {
      document.querySelector(sel)?.focus();
    }, COMPOSE_BOX);
    await sleep(2_000); // wait for React editor to fully initialise before inserting text

    // Insert via execCommand — atomic insert, prevents character truncation
    // (keyboard.type with delay: 15 was dropping initial characters)
    console.log("[post_quote] inserting commentary via execCommand...");
    await page.evaluate((text, sel) => {
      const el = document.querySelector(sel);
      if (el) { el.focus(); document.execCommand("insertText", false, text); }
    }, quoteText, COMPOSE_BOX);
    await sleep(1_500);

    // Verify text was inserted correctly — retry once with keyboard fallback if not
    const insertedText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.trim() : "";
    }, COMPOSE_BOX);
    if (!insertedText || insertedText.length < quoteText.length * 0.8) {
      console.log(`[post_quote] text verification: got ${insertedText.length}/${quoteText.length} chars — retrying with keyboard`);
      // Clear and retry with keyboard
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
      }, COMPOSE_BOX);
      await sleep(500);
      await page.keyboard.type(quoteText, { delay: 30 });
      await sleep(1_000);
    } else {
      console.log(`[post_quote] text verified: ${insertedText.length}/${quoteText.length} chars`);
    }

    // Poll for Post button to be enabled (not aria-disabled)
    await poll(page, "post button enabled", () => {
      const el = document.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]');
      return el != null && el.getAttribute("aria-disabled") !== "true";
    }, { attempts: 30, interval: 1_000 });

    // Click Post
    console.log("[post_quote] clicking Post...");
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, POST_BUTTON);
    await sleep(3_500);

    // Capture result — navigate to own profile to confirm post and get URL
    const finalUrl = page.url();
    let quoteUrl = null;
    if (/x\.com\/\w+\/status\/\d+/.test(finalUrl)) {
      quoteUrl = finalUrl;
    }

    if (!quoteUrl) {
      console.log("[post_quote] navigating to profile to confirm post and capture URL...");
      await page.goto("https://x.com/sebastianhunts", { waitUntil: "domcontentloaded", timeout: 20_000 });
      await sleep(3_000);
      quoteUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/status/"]'));
        const match = links.find(a => /\/sebastianhunts\/status\/\d+/.test(a.getAttribute("href") || ""));
        if (match) return "https://x.com" + match.getAttribute("href").split("?")[0];
        return null;
      });
      if (quoteUrl) {
        console.log(`[post_quote] SUCCESS (confirmed from profile): ${quoteUrl}`);
      } else {
        console.log("[post_quote] posted — could not confirm URL from profile");
      }
    } else {
      console.log(`[post_quote] SUCCESS: ${quoteUrl}`);
    }

    fs.writeFileSync(RESULT_FILE, (quoteUrl || "posted") + "\n");

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
