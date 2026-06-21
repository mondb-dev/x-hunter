#!/usr/bin/env node
/**
 * runner/delete_tweet.js — delete a specific tweet by URL
 * Usage: node runner/delete_tweet.js https://x.com/username/status/ID
 */
"use strict";

const { connectBrowser, getXPage } = require("./cdp");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const tweetUrl = process.argv[2];
  if (!tweetUrl || !tweetUrl.includes("/status/")) {
    console.error("Usage: node delete_tweet.js https://x.com/username/status/ID");
    process.exit(1);
  }

  console.log(`[delete_tweet] deleting: ${tweetUrl}`);
  const browser = await connectBrowser();
  const page    = await getXPage(browser);

  await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(3_000);

  // Open the three-dot menu on the tweet
  const opened = await page.evaluate(() => {
    const carets = Array.from(document.querySelectorAll("[data-testid='caret']"));
    if (carets.length) { carets[0].click(); return true; }
    return false;
  });

  if (!opened) throw new Error("Could not open tweet menu (caret not found)");
  await sleep(1_000);

  // Click Delete
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("[role='menuitem']"));
    const del = items.find(i => i.innerText?.toLowerCase().includes("delete"));
    if (del) { del.click(); return true; }
    return false;
  });

  if (!clicked) throw new Error("Delete menu item not found");
  await sleep(800);

  // Confirm deletion
  const confirmed = await page.evaluate(() => {
    const btn = document.querySelector("[data-testid='confirmationSheetConfirm']");
    if (btn) { btn.click(); return true; }
    const all = Array.from(document.querySelectorAll("button"));
    const d = all.find(b => b.innerText?.trim().toLowerCase() === "delete");
    if (d) { d.click(); return true; }
    return false;
  });

  await sleep(2_000);
  console.log(`[delete_tweet] deleted: ${confirmed} — ${tweetUrl}`);
  browser.disconnect();
}

main().catch(err => {
  console.error("[delete_tweet] fatal:", err.message);
  process.exit(1);
});
