#!/usr/bin/env node
/**
 * runner/prefetch_url.js — pre-navigate browser to curiosity search URL before browse cycle
 *
 * Reads the ACTIVE SEARCH URL from state/curiosity_directive.txt and navigates
 * the CDP-connected Chrome to that URL. By the time the browse agent starts,
 * the page is already loaded and the agent can read it without spending navigation
 * tool calls.
 *
 * If no URL is found in the directive, navigates to x.com/home (neutral reset).
 *
 * Exit 0 always (non-fatal — browser failure should not block browse cycle).
 *
 * Usage: node runner/prefetch_url.js
 * Called by run.sh at the start of each browse cycle, before agent_run.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser, getXPage, CDP_URL } = require("./cdp");

const ROOT         = path.resolve(__dirname, "..");
const DIRECTIVE    = path.join(ROOT, "state", "curiosity_directive.txt");
const READING_URL  = path.join(ROOT, "state", "reading_url.txt");
const HOME_URL     = "https://x.com/home";
const TIMEOUT      = 20_000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Extract all SEARCH_URL_N: lines from curiosity directive; rotate by cycle. */
function extractSearchUrl(text, cycle) {
  if (!text) return null;
  // New multi-angle format: SEARCH_URL_1:, SEARCH_URL_2:, SEARCH_URL_3:
  const angles = [];
  const re = /SEARCH_URL_\d+:\s*(https?:\/\/\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) angles.push(m[1].trim());
  if (angles.length > 0) {
    const idx = (cycle || 0) % angles.length;
    return angles[idx];
  }
  // Legacy fallback: single Navigate: line
  const legacy = text.match(/Navigate:\s*(https?:\/\/\S+)/);
  return legacy ? legacy[1].trim() : null;
}

(async () => {
  // Read target URL — deep dive takes priority over curiosity
  let targetUrl = HOME_URL;
  let targetType = "home";
  try {
    // 1. Deep dive (reading queue) takes priority
    if (fs.existsSync(READING_URL)) {
      const rtext = fs.readFileSync(READING_URL, "utf-8").trim();
      const rm = rtext.match(/^URL:\s*(.+)$/m);
      if (rm && rm[1].trim()) {
        targetUrl = rm[1].trim();
        targetType = "deep_dive";
        console.log(`[prefetch] deep dive URL: ${targetUrl}`);
      }
    }
    // 2. Curiosity search if no deep dive active
    if (targetType === "home" && fs.existsSync(DIRECTIVE)) {
      const text = fs.readFileSync(DIRECTIVE, "utf-8");
      const cycle = parseInt(process.env.PREFETCH_CYCLE || "0", 10);
      const searchUrl = extractSearchUrl(text, cycle);
      if (searchUrl) {
        targetUrl = searchUrl;
        targetType = "curiosity";
        console.log(`[prefetch] curiosity URL: ${targetUrl}`);
      } else {
        console.log("[prefetch] no ACTIVE SEARCH URL in directive — navigating to home");
      }
    }
    if (targetType === "home") {
      console.log("[prefetch] no curiosity directive — navigating to home");
    }
  } catch (e) {
    console.log(`[prefetch] could not read directive: ${e.message} — navigating to home`);
  }

  // Connect to Chrome (connectBrowser does the pre-flight /json/version fetch internally)
  let browser;
  try {
    browser = await connectBrowser(5_000);
  } catch (err) {
    console.log(`[prefetch] Chrome not available (${err.message}) — skipping`);
    process.exit(0);
  }

  try {
    const page = await getXPage(browser);

    console.log(`[prefetch] navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await sleep(2_500); // let dynamic content load

    console.log(`[prefetch] done — page ready at ${page.url()}`);
  } catch (err) {
    console.log(`[prefetch] navigation error: ${err.message} — continuing`);
  } finally {
    browser.disconnect();
  }

  process.exit(0);
})();
