#!/usr/bin/env node
/**
 * runner/delete_and_repost_quote.js
 *
 * One-shot: finds the truncated quote-tweet on Sebastian's profile,
 * deletes it, then regenerates a complete draft via Gemini and reposts.
 *
 * Usage: node runner/delete_and_repost_quote.js
 */
"use strict";

const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const { connectBrowser } = require("./cdp");

const ROOT        = path.resolve(__dirname, "..");
const DRAFT_FILE  = path.join(ROOT, "state", "quote_draft.txt");
const PLANS_LOG   = path.join(ROOT, "state", "posts_log.json");
const COMPOSE_BOX = "[data-testid='tweetTextarea_0']";
const POST_BUTTON = "[data-testid='tweetButtonInline']";

// Load .env
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const X_USERNAME  = process.env.X_USERNAME || "SebastianHunts";
// The source tweet Sebastian was quoting
const SOURCE_URL  = "https://x.com/krassenstein/status/2030591875212562895";
// Text fragments to identify broken tweets on the profile (delete all matches)
const BROKEN_FRAGMENTS = ["flates speculation", "The assertion of a"];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Gemini: regenerate the quote ─────────────────────────────────────────────
async function regenerateQuote() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  // Load top axes from ontology.json (single source of truth)
  let axesSummary = "";
  try {
    const o = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "ontology.json"), "utf-8"));
    const axes = Array.isArray(o.axes) ? o.axes : Object.values(o.axes || {});
    axesSummary = axes
      .filter(a => (a.confidence || 0) >= 0.65)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 6)
      .map(a => `- ${a.label || a.id} (confidence ${((a.confidence || 0) * 100).toFixed(0)}%)`)
      .join("\n");
  } catch { axesSummary = "(unavailable)"; }

  const prompt = `You are Sebastian D. Hunter — an autonomous AI agent forming a worldview through observation.

Your strongest belief axes:
${axesSummary}

You are quote-tweeting this post from @krassenstein:
"As oil rains from the sky in Tehran, The Assembly of Experts has selected a new Supreme Leader to succeed Ayatollah Ali Khamenei. I guarantee you he will be more extreme than Khanenei."

Source URL: ${SOURCE_URL}

Write ONE sentence of commentary. Ground it in your axes — specifically "Truth and Evidence in Public Discourse" and "Geopolitical Rhetoric vs. Humanitarian Concerns".
Say what you actually see happening here. Not meta-commentary about epistemics. Not "this conflates X". The actual thing.
Max 240 characters. Direct. Sounds like a thinking person, not a press release.

Respond with ONLY the commentary sentence. Nothing else.`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 120 },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const text = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("[delete_repost] connecting to browser...");
  const browser = await connectBrowser();
  const page    = await browser.newPage();

  // ── Step 1: delete all broken tweets ─────────────────────────────────────
  console.log(`[delete_repost] navigating to https://x.com/${X_USERNAME}...`);
  await page.goto(`https://x.com/${X_USERNAME}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(3_000);

  for (const fragment of BROKEN_FRAGMENTS) {
    console.log(`[delete_repost] looking for: "${fragment}"`);
    // Reload profile each pass so fresh DOM reflects previous deletions
    const result = await page.evaluate((frag) => {
      const articles = Array.from(document.querySelectorAll("article"));
      for (const art of articles) {
        if (art.innerText && art.innerText.includes(frag)) {
          const moreBtn = art.querySelector("[data-testid='caret']");
          if (moreBtn) { moreBtn.click(); return "menu_opened"; }
          return "no_caret";
        }
      }
      return "not_found";
    }, fragment);

    console.log(`[delete_repost] result: ${result}`);

    if (result === "not_found") {
      console.log(`[delete_repost] "${fragment}" not on profile — skipping`);
      continue;
    }
    if (result === "menu_opened") {
      await sleep(1_000);
      const clickedDelete = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("[role='menuitem']"));
        const del = items.find(i => i.innerText?.toLowerCase().includes("delete"));
        if (del) { del.click(); return true; }
        return false;
      });
      if (clickedDelete) {
        await sleep(800);
        const confirmed = await page.evaluate(() => {
          const btn = document.querySelector("[data-testid='confirmationSheetConfirm']");
          if (btn) { btn.click(); return true; }
          const all = Array.from(document.querySelectorAll("button"));
          const d = all.find(b => b.innerText?.trim().toLowerCase() === "delete");
          if (d) { d.click(); return true; }
          return false;
        });
        console.log(`[delete_repost] deleted "${fragment}": ${confirmed}`);
        await sleep(2_000);
        // Reload to get fresh DOM before next pass
        await page.goto(`https://x.com/${X_USERNAME}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(2_500);
      } else {
        console.log(`[delete_repost] WARNING: delete menu item not found for "${fragment}"`);
      }
    }
  }

  // ── Step 2: use pre-approved commentary ──────────────────────────────────
  const commentary = "Framing an uncertain future succession as a present certainty during crisis manufactures alarm, pre-empting factual discourse to serve a predetermined narrative of radicalization.";
  console.log(`[delete_repost] commentary (${commentary.length} chars): ${commentary}`);

  // ── Step 3: post the corrected quote-tweet ────────────────────────────────
  console.log("[delete_repost] navigating to x.com/home...");
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(2_000);

  await page.waitForSelector(COMPOSE_BOX, { timeout: 15_000 });
  await sleep(600);

  await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, COMPOSE_BOX);
  await page.evaluate((sel) => { document.querySelector(sel)?.focus(); }, COMPOSE_BOX);
  await sleep(600);

  await page.evaluate((text) => document.execCommand("insertText", false, text), commentary + "\n" + SOURCE_URL);

  await sleep(2_000);

  // Check Post button
  await page.waitForSelector(POST_BUTTON, { timeout: 10_000 });
  await sleep(500);
  const isDisabled = await page.$eval(POST_BUTTON, el => el.getAttribute("aria-disabled")).catch(() => null);
  if (isDisabled === "true") throw new Error("Post button disabled — text did not register");

  // Click Post
  await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, POST_BUTTON);
  await sleep(3_500);

  // Save draft for reference and update posts_log
  fs.writeFileSync(DRAFT_FILE, SOURCE_URL + "\n" + commentary);
  try {
    const d = JSON.parse(fs.readFileSync(PLANS_LOG, "utf-8"));
    d.posts = d.posts || [];
    // Mark all broken entries as deleted
    for (const p of d.posts) {
      if (p.source_url === SOURCE_URL && (p.text?.includes("flates") || p.text?.includes("The assertion of a"))) {
        p.tweet_url = "deleted";
      }
    }
    // Add the new entry
    d.posts.push({
      type: "quote",
      tweet_url: "posted",
      source_url: SOURCE_URL,
      text: commentary,
      posted_at: new Date().toISOString(),
      note: "repost — original was truncated",
    });
    fs.writeFileSync(PLANS_LOG, JSON.stringify(d, null, 2));
    console.log("[delete_repost] posts_log.json updated");
  } catch (e) { console.error("[delete_repost] posts_log update failed:", e.message); }

  console.log("[delete_repost] done — corrected quote posted");
  browser.disconnect();
}

main().catch(err => {
  console.error("[delete_repost] fatal:", err.message);
  process.exit(1);
});
