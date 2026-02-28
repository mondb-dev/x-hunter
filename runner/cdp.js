"use strict";
/**
 * runner/cdp.js — shared Chrome CDP connection helper
 *
 * Fetches the WebSocket debugger URL from /json/version, then connects
 * via puppeteer-core using the WS endpoint (faster and more compatible
 * than browserURL which may hang on large target counts).
 *
 * Also provides getXPage(browser) which finds an existing x.com page via
 * browser.targets() (avoids browser.pages() which creates all 26+ Page objects).
 *
 * Usage:
 *   const { connectBrowser, getXPage } = require("./cdp");
 *   const browser = await connectBrowser();
 *   const page    = await getXPage(browser);
 */

const puppeteer = require("puppeteer-core");

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:18801";

/**
 * Connect to running Chrome via CDP.
 * Fetches WS endpoint from /json/version first.
 * @param {number} [timeout=10000] - ms timeout for the HTTP preflight
 * @returns {Promise<import("puppeteer-core").Browser>}
 */
async function connectBrowser(timeout = 10_000) {
  // 1. Fetch WS endpoint (fast HTTP call, respects timeout)
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeout);
  let wsUrl;
  try {
    const res  = await fetch(`${CDP_URL}/json/version`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    wsUrl = data.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("webSocketDebuggerUrl missing from /json/version");
  } finally {
    clearTimeout(t);
  }

  // 2. Connect via WS endpoint (avoids browserURL hang on large target counts)
  return puppeteer.connect({ browserWSEndpoint: wsUrl });
}

/**
 * Find an existing x.com page, or fall back to the first available page.
 * Uses browser.targets() which is synchronous and instant (no Page object creation).
 * @param {import("puppeteer-core").Browser} browser
 * @returns {Promise<import("puppeteer-core").Page>}
 */
async function getXPage(browser) {
  const targets = browser.targets();
  const xTarget = targets.find(t => t.type() === "page" && /x\.com/.test(t.url()));
  if (xTarget) return xTarget.page();

  // Fallback: first page target
  const firstPage = targets.find(t => t.type() === "page");
  if (firstPage) return firstPage.page();

  // Nothing open — open a new tab
  return browser.newPage();
}

module.exports = { connectBrowser, getXPage, CDP_URL };
