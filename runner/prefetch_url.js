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
const { chromium } = require("playwright-core");

const ROOT      = path.resolve(__dirname, "..");
const DIRECTIVE = path.join(ROOT, "state", "curiosity_directive.txt");
const CDP_URL   = "http://127.0.0.1:18801";
const HOME_URL  = "https://x.com/home";
const TIMEOUT   = 20_000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Extract the ACTIVE SEARCH Navigate: URL from the curiosity directive. */
function extractSearchUrl(text) {
  if (!text) return null;
  const m = text.match(/Navigate:\s*(https?:\/\/\S+)/);
  return m ? m[1].trim() : null;
}

(async () => {
  // Read directive
  let targetUrl = HOME_URL;
  try {
    if (fs.existsSync(DIRECTIVE)) {
      const text = fs.readFileSync(DIRECTIVE, "utf-8");
      const searchUrl = extractSearchUrl(text);
      if (searchUrl) {
        targetUrl = searchUrl;
        console.log(`[prefetch] curiosity URL: ${targetUrl}`);
      } else {
        console.log("[prefetch] no ACTIVE SEARCH URL in directive — navigating to home");
      }
    } else {
      console.log("[prefetch] no curiosity directive — navigating to home");
    }
  } catch (e) {
    console.log(`[prefetch] could not read directive: ${e.message} — navigating to home`);
  }

  // Quick pre-flight: check CDP port is responding (3s timeout) before attempting playwright
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 3_000);
    const r    = await fetch(`${CDP_URL}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    console.log(`[prefetch] Chrome not available (${err.message}) — skipping`);
    process.exit(0);
  }

  // Connect to Chrome
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.log(`[prefetch] playwright connect failed: ${err.message} — skipping`);
    process.exit(0);
  }

  try {
    const contexts = browser.contexts();
    if (!contexts.length) {
      console.log("[prefetch] no browser context — skipping");
      await browser.close();
      process.exit(0);
    }

    const context = contexts[0];
    let page = context.pages().find(p => /x\.com/.test(p.url()));
    if (!page) page = context.pages()[0] || await context.newPage();

    console.log(`[prefetch] navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await sleep(2_500); // let dynamic content load

    console.log(`[prefetch] done — page ready at ${page.url()}`);
  } catch (err) {
    console.log(`[prefetch] navigation error: ${err.message} — continuing`);
  } finally {
    await browser.close();
  }

  process.exit(0);
})();
