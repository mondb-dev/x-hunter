#!/usr/bin/env node
/**
 * runner/post_article.js — publish an X Article (long-form) via CDP
 *
 * Connects to the running Chrome session and publishes an article using
 * the X Article editor (https://x.com/i/article).
 *
 * Input (CLI):  state/article_x_draft.json  { title: string, body: string }
 * Output:       state/article_x_result.txt   (article URL + title)
 *
 * Module usage:
 *   const { postArticle } = require("./post_article");
 *   const url = await postArticle(page, { title, body });
 *
 * Usage: node runner/post_article.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser, getXPage } = require("./cdp");
const { logArticle } = require("./posts_log");

const ROOT        = path.resolve(__dirname, "..");
const DRAFT_FILE  = path.join(ROOT, "state", "article_x_draft.json");
const RESULT_FILE = path.join(ROOT, "state", "article_x_result.txt");

const ARTICLE_URL = "https://x.com/i/article";

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Editor field discovery ────────────────────────────────────────────────────

/**
 * Find all editable areas on the article editor page.
 * Returns an array of { index, testId, placeholder, y } sorted top-to-bottom.
 * Title is typically the first, body the second.
 */
async function discoverFields(page, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const fields = await page.evaluate(() => {
      const seen = new Set();
      const candidates = [];
      for (const el of document.querySelectorAll(
        '[role="textbox"], [contenteditable="true"], [data-testid*="itle"], [data-testid*="ody"]'
      )) {
        if (seen.has(el)) continue;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 10) continue; // too small
        candidates.push({
          tag:         el.tagName,
          role:        el.getAttribute("role"),
          testId:      el.getAttribute("data-testid") || "",
          placeholder: el.getAttribute("data-placeholder")
                    || el.getAttribute("placeholder")
                    || el.getAttribute("aria-label")
                    || "",
          y:           rect.top,
          x:           rect.left,
          w:           rect.width,
          h:           rect.height,
          editable:    el.contentEditable === "true",
        });
      }
      return candidates.sort((a, b) => a.y - b.y);
    });

    if (fields.length >= 2) {
      console.log(`[post_article] found ${fields.length} editor fields:`);
      fields.forEach((f, i) =>
        console.log(`  [${i}] ${f.tag} testId="${f.testId}" placeholder="${f.placeholder}" y=${f.y.toFixed(0)}`),
      );
      return fields;
    }

    // Single field — might be a combined title + body editor
    if (fields.length === 1) {
      console.log("[post_article] found 1 editor field — treating as combined title+body");
      return fields;
    }

    await sleep(1_000);
  }

  throw new Error("No editable fields found on article editor page");
}

// ── Text insertion ────────────────────────────────────────────────────────────

/**
 * Click+focus an editor field by its bounding-box center, then insert text
 * via execCommand (React-safe). Falls back to keyboard.type if execCommand fails.
 */
async function clickAndType(page, field, text) {
  const cx = field.x + field.w / 2;
  const cy = field.y + field.h / 2;
  await page.mouse.click(cx, cy);
  await sleep(300);

  // Also focus via evaluate as a safety net
  await page.evaluate(({ testId, y }) => {
    let el;
    if (testId) el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) {
      const all = [...document.querySelectorAll('[role="textbox"], [contenteditable="true"]')]
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      el = all.find(e => Math.abs(e.getBoundingClientRect().top - y) < 20);
    }
    if (el) el.focus();
  }, field);
  await sleep(300);

  // Insert via execCommand
  const ok = await page.evaluate(txt => document.execCommand("insertText", false, txt), text);
  if (ok) {
    await sleep(200);
    return;
  }

  // Fallback: keyboard.type in chunks (slow but reliable)
  console.log("[post_article] execCommand failed — typing via keyboard...");
  const CHUNK = 300;
  for (let i = 0; i < text.length; i += CHUNK) {
    await page.keyboard.type(text.slice(i, i + CHUNK), { delay: 3 });
    await sleep(100);
  }
}

// ── Publish button ────────────────────────────────────────────────────────────

async function clickPublish(page, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate(() => {
      // Priority 1: data-testid
      for (const sel of [
        '[data-testid="publishButton"]',
        '[data-testid="articlePublishButton"]',
        '[data-testid*="ublish"]',
      ]) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled) { btn.click(); return sel; }
      }
      // Priority 2: button text
      for (const btn of document.querySelectorAll("button, [role='button']")) {
        const txt = (btn.innerText || "").trim().toLowerCase();
        if (txt === "publish" || txt === "post") {
          if (!btn.disabled) { btn.click(); return `text:${txt}`; }
        }
      }
      return null;
    });

    if (clicked) {
      console.log(`[post_article] clicked publish via: ${clicked}`);
      return true;
    }
    await sleep(1_000);
  }
  throw new Error("Publish button not found or not enabled");
}

// ── Capture article URL ───────────────────────────────────────────────────────

async function captureArticleUrl(page) {
  await sleep(5_000); // wait for publish + redirect

  const url = page.url();
  if (/x\.com\/\w+\/status\/\d+/.test(url)) return url;

  // Check profile for the latest post
  console.log("[post_article] checking profile for article URL...");
  await page.goto("https://x.com/sebastianhunts", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(3_000);
    const found = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/status/"]'));
      const match = links.find(a =>
        /\/sebastianhunts\/status\/\d+/.test(a.getAttribute("href") || ""),
      );
      if (match) return "https://x.com" + match.getAttribute("href").split("?")[0];
      return null;
    });
    if (found) return found;
    if (attempt < 4) console.log(`[post_article] URL not found (attempt ${attempt}/4)...`);
  }

  return null;
}

// ── Cover image upload ────────────────────────────────────────────────────────

/**
 * Upload a cover/hero image to the X Article editor.
 * Finds a file input or "Add cover photo" button and uploads via file chooser.
 *
 * @param {import("puppeteer-core").Page} page
 * @param {string} imagePath - absolute path to PNG/JPG file
 * @returns {Promise<boolean>} true if uploaded
 */
async function uploadCoverImage(page, imagePath) {
  // Strategy 1: hidden <input type="file"> already on page
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    await fileInput.uploadFile(imagePath);
    await sleep(2_000);
    return true;
  }

  // Strategy 2: click "Add cover photo" or similar button, wait for file dialog
  const clicked = await page.evaluate(() => {
    // Look for cover image area by text or data-testid
    for (const sel of [
      '[data-testid*="cover"]',
      '[data-testid*="image"]',
      '[aria-label*="cover"]',
      '[aria-label*="image"]',
    ]) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return sel; }
    }
    // Look by text content
    for (const el of document.querySelectorAll("button, [role='button'], div, span")) {
      const txt = (el.innerText || "").trim().toLowerCase();
      if (txt.includes("cover") || txt.includes("add image") || txt.includes("add photo")) {
        el.click();
        return `text:${txt}`;
      }
    }
    return null;
  });

  if (clicked) {
    console.log(`[post_article] clicked cover area: ${clicked}`);
    await sleep(1_000);

    // After clicking, a file input may appear
    const fileInputAfter = await page.$('input[type="file"]');
    if (fileInputAfter) {
      await fileInputAfter.uploadFile(imagePath);
      await sleep(2_000);
      return true;
    }
  }

  return false;
}

// ── Main: postArticle ─────────────────────────────────────────────────────────

/**
 * Post an X Article. Requires an active page with x.com session.
 *
 * @param {import("puppeteer-core").Page} page
 * @param {{ title: string, body: string, imagePath?: string }} content
 * @returns {Promise<string|null>} article URL or null
 */
async function postArticle(page, { title, body, imagePath }) {
  console.log(`[post_article] opening article editor...`);
  await page.goto(ARTICLE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(4_000); // wait for React editor to hydrate

  // ── Cover image upload (if provided) ──────────────────────────────────

  if (imagePath && fs.existsSync(imagePath)) {
    console.log(`[post_article] uploading cover image: ${imagePath}`);
    try {
      // Look for image upload button/area before the editor fields load
      // X Article editor has an "Add cover photo" or image upload area at the top
      const uploaded = await uploadCoverImage(page, imagePath);
      if (uploaded) {
        console.log("[post_article] cover image uploaded");
        await sleep(2_000); // wait for image processing
      } else {
        console.log("[post_article] cover image upload skipped (no upload target found)");
      }
    } catch (err) {
      console.warn(`[post_article] cover image upload failed: ${err.message}`);
      console.warn("[post_article] continuing without cover image");
    }
  }

  // Discover fields
  const fields = await discoverFields(page);

  if (fields.length >= 2) {
    // Separate title + body fields
    console.log("[post_article] inserting title...");
    await clickAndType(page, fields[0], title);
    await sleep(500);

    console.log(`[post_article] inserting body (${body.length} chars)...`);
    await clickAndType(page, fields[1], body);
  } else {
    // Combined editor — title then double-enter then body
    console.log("[post_article] inserting into combined field...");
    await clickAndType(page, fields[0], title);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await sleep(300);

    const ok = await page.evaluate(txt => document.execCommand("insertText", false, txt), body);
    if (!ok) {
      const CHUNK = 300;
      for (let i = 0; i < body.length; i += CHUNK) {
        await page.keyboard.type(body.slice(i, i + CHUNK), { delay: 3 });
        await sleep(100);
      }
    }
  }

  // Dismiss any @mention autocomplete overlay
  await page.keyboard.press("Escape");
  await sleep(500);

  // Verify text was inserted
  const charCount = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[role="textbox"], [contenteditable="true"]')];
    return boxes.reduce((sum, el) => sum + (el.innerText || "").length, 0);
  });
  console.log(`[post_article] editor char count: ${charCount}`);
  if (charCount < title.length + 50) {
    throw new Error(`Text insertion suspect — only ${charCount} chars in editor (expected ~${title.length + body.length})`);
  }

  // Publish
  await clickPublish(page);

  // Capture URL
  const articleUrl = await captureArticleUrl(page);

  // Navigate home to clean up
  await page.goto("https://x.com/home", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  }).catch(() => {});

  return articleUrl;
}

module.exports = { postArticle };

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    if (!fs.existsSync(DRAFT_FILE)) {
      console.error("[post_article] no article_x_draft.json — skipping");
      process.exit(1);
    }

    const { title, body } = JSON.parse(fs.readFileSync(DRAFT_FILE, "utf-8"));
    if (!title || !body) {
      console.error("[post_article] draft missing title or body");
      process.exit(1);
    }

    console.log(`[post_article] title: "${title}"`);
    console.log(`[post_article] body: ${body.length} chars`);

    let browser;
    try {
      browser = await connectBrowser();
    } catch (err) {
      console.error(`[post_article] chrome connect failed: ${err.message}`);
      process.exit(1);
    }

    const page = await getXPage(browser);

    try {
      const url = await postArticle(page, { title, body });
      fs.writeFileSync(RESULT_FILE, `${url || "published"}\n${title}\n`);
      logArticle({ title, content: body, article_url: url || "" });
      console.log("[post_article] done.");
    } catch (err) {
      console.error(`[post_article] FAILED: ${err.message}`);
      if (err.stack) console.error(err.stack);
      browser.disconnect();
      process.exit(1);
    }

    browser.disconnect();
    process.exit(0);
  })();
}
