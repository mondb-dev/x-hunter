#!/usr/bin/env node
/**
 * runner/browser_check.js — functional browser health check
 *
 * Connects to Chrome via playwright-core CDP and verifies the connection
 * works end-to-end (not just that the TCP port is open).
 *
 * Exit 0 = healthy
 * Exit 1 = not healthy (Chrome down, CDP refused, or connect timeout)
 *
 * Usage: node runner/browser_check.js
 * Timeout: 5s (hard abort)
 */

"use strict";

const { chromium } = require("playwright-core");
const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:18801";
const TIMEOUT_MS = 5_000;

const timer = setTimeout(() => {
  console.error("[browser_check] timeout after 5s");
  process.exit(1);
}, TIMEOUT_MS);

(async () => {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    // Verify at least one context is accessible
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error("no browser contexts");
    await browser.close();
    clearTimeout(timer);
    process.exit(0);
  } catch (e) {
    clearTimeout(timer);
    console.error("[browser_check] failed:", e.message);
    process.exit(1);
  }
})();
