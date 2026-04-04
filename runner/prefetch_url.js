#!/usr/bin/env node
/**
 * runner/prefetch_url.js — pre-navigate browser before each browse cycle
 *
 * Primary target: X/Twitter. When X is unavailable (login redirect, GCP block):
 *   curiosity cycles  → Reddit search on the same query
 *   deep_dive cycles  → direct scholarly URL or Google Scholar search
 *   home cycles       → Hacker News top stories
 *
 * Writes state/prefetch_source.txt: line 1 = source label, line 2 = URL.
 * Exit 0 always — browser failure must not block the browse cycle.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser, getXPage } = require("./cdp");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const ROOT        = path.resolve(__dirname, "..");
const DIRECTIVE   = path.join(ROOT, "state", "curiosity_directive.txt");
const READING_URL = path.join(ROOT, "state", "reading_url.txt");
const SOURCE_FILE = path.join(ROOT, "state", "prefetch_source.txt");
const HOME_URL    = "https://x.com/home";
const TIMEOUT     = 20_000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isLoginRedirectUrl(url) { return /x\.com\/i\/flow\/login/.test(String(url || "")); }
function writeSource(label, url) {
  try { fs.writeFileSync(SOURCE_FILE, `${label}\n${url}\n`, "utf-8"); } catch {}
}

/** Extract SEARCH_URL_N lines from curiosity directive; rotate by cycle. */
function extractSearchUrl(text, cycle) {
  if (!text) return null;
  const angles = [];
  const re = /SEARCH_URL_\d+:\s*(https?:\/\/\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) angles.push(m[1].trim());
  if (angles.length > 0) return angles[(cycle || 0) % angles.length];
  const legacy = text.match(/Navigate:\s*(https?:\/\/\S+)/);
  return legacy ? legacy[1].trim() : null;
}

/** Pull a search query from an X search URL or the directive text. */
function extractQuery(xUrl, directiveText) {
  try {
    const u = new URL(xUrl);
    const q = u.searchParams.get("q");
    if (q) return q;
  } catch {}
  if (directiveText) {
    const m = directiveText.match(/AMBIENT FOCUS[:\s]+(.+)/i) ||
              directiveText.match(/TOPIC[:\s]+(.+)/i);
    if (m) return m[1].replace(/\(.*?\)/g, "").trim().split(/\s+/).slice(0, 6).join(" ");
  }
  return null;
}

/** curiosity fallback → Reddit search */
function toRedditUrl(xUrl, directiveText) {
  const q = extractQuery(xUrl, directiveText);
  if (q) return `https://www.reddit.com/search/?q=${encodeURIComponent(q)}&sort=hot&t=week`;
  return "https://www.reddit.com/r/worldnews/hot/";
}

/** deep_dive fallback → scholarly source or Google Scholar search */
function toScholarlyUrl(deepDiveUrl, readingUrlText) {
  const scholarly = /arxiv\.org|scholar\.google|pubmed\.ncbi|ssrn\.com|doi\.org|semanticscholar\.org|jstor\.org/;
  if (scholarly.test(deepDiveUrl)) return deepDiveUrl;
  let topic = "";
  if (readingUrlText) {
    const tm = readingUrlText.match(/TOPIC[:\s]+(.+)/i) ||
               readingUrlText.match(/TITLE[:\s]+(.+)/i);
    if (tm) topic = tm[1].trim().split(/\s+/).slice(0, 6).join(" ");
  }
  if (topic) return `https://scholar.google.com/scholar?q=${encodeURIComponent(topic)}`;
  return "https://news.ycombinator.com/";
}

/** Label a URL by its content source. */
function classifySource(url) {
  if (/reddit\.com/.test(url))              return "reddit";
  if (/arxiv\.org/.test(url))              return "arxiv";
  if (/scholar\.google/.test(url))         return "scholar";
  if (/news\.ycombinator\.com/.test(url))  return "hackernews";
  if (/ssrn\.com/.test(url))               return "ssrn";
  if (/pubmed/.test(url))                  return "pubmed";
  if (/semanticscholar\.org/.test(url))    return "scholar";
  if (/reuters\.com/.test(url))            return "reuters";
  if (/bbc\.com|bbc\.co\.uk/.test(url))   return "bbc";
  if (/x\.com|twitter\.com/.test(url))    return "x";
  return "web";
}

(async () => {
  writeSource("x", HOME_URL); // default; overwritten below

  let targetUrl     = HOME_URL;
  let targetType    = "home";
  let directiveText = "";
  let readingUrlText = "";

  try {
    if (fs.existsSync(READING_URL)) {
      readingUrlText = fs.readFileSync(READING_URL, "utf-8").trim();
      const rm = readingUrlText.match(/^URL:\s*(.+)$/m);
      if (rm && rm[1].trim()) {
        targetUrl  = rm[1].trim();
        targetType = "deep_dive";
        console.log(`[prefetch] deep dive URL: ${targetUrl}`);
      }
    }
    if (targetType === "home" && fs.existsSync(DIRECTIVE)) {
      directiveText = fs.readFileSync(DIRECTIVE, "utf-8");
      const cycle   = parseInt(process.env.PREFETCH_CYCLE || "0", 10);
      const searchUrl = extractSearchUrl(directiveText, cycle);
      if (searchUrl) {
        targetUrl  = searchUrl;
        targetType = "curiosity";
        console.log(`[prefetch] curiosity URL: ${targetUrl}`);
      } else {
        console.log("[prefetch] no ACTIVE SEARCH URL in directive — navigating to home");
      }
    }
    if (targetType === "home") console.log("[prefetch] no curiosity directive — navigating to home");
  } catch (e) {
    console.log(`[prefetch] could not read directive: ${e.message} — navigating to home`);
  }

  let browser;
  try {
    browser = await connectBrowser(5_000);
  } catch (err) {
    console.log(`[prefetch] Chrome not available (${err.message}) — skipping prefetch`);
    writeSource("none", targetUrl);
    process.exit(0);
  }

  try {
    const page = await getXPage(browser);

    console.log(`[prefetch] navigating to ${targetUrl}`);
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    } catch (gotoErr) {
      // X.com SPA replaces the main frame during navigation — puppeteer loses the
      // original frame reference and throws "detached Frame". The navigation still
      // completes; ignore this specific error and continue.
      if (!gotoErr.message.includes('detached Frame') && !gotoErr.message.includes('detached frame')) {
        throw gotoErr;
      }
    }
    await sleep(2_500);

    let currentUrl = "";
    try { currentUrl = page.url(); } catch {}
    if (isLoginRedirectUrl(currentUrl)) {
      console.log("[prefetch] X login redirect — switching to fallback source");

      let fallbackUrl;
      if (targetType === "deep_dive") {
        fallbackUrl = toScholarlyUrl(targetUrl, readingUrlText);
        console.log(`[prefetch] deep dive fallback (scholarly): ${fallbackUrl}`);
      } else if (targetType === "curiosity") {
        fallbackUrl = toRedditUrl(targetUrl, directiveText);
        console.log(`[prefetch] curiosity fallback (reddit): ${fallbackUrl}`);
      } else {
        fallbackUrl = "https://news.ycombinator.com/";
        console.log(`[prefetch] home fallback (hackernews): ${fallbackUrl}`);
      }

      await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      await sleep(2_500);
      const source = classifySource(page.url());
      writeSource(source, page.url());
      console.log(`[prefetch] fallback ready — source: ${source} at ${page.url()}`);
    } else {
      const source = classifySource(currentUrl || targetUrl);
      writeSource(source, currentUrl || targetUrl);
      console.log(`[prefetch] done — source: ${source} at ${currentUrl || targetUrl}`);
    }
  } catch (err) {
    console.log(`[prefetch] navigation error: ${err.message}`);
    writeSource("none", targetUrl);
  } finally {
    browser.disconnect();
  }

  process.exit(0);
})();
