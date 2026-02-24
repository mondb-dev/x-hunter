#!/usr/bin/env node
/**
 * scraper/reply.js — FIFO reply queue processor
 *
 * Reads state/reply_queue.jsonl, processes pending items oldest-first:
 *   1. Algorithmic spam pre-filter (no API call wasted)
 *   2. Gemini API: classify WORTHY/SKIP + draft reply
 *   3. Post reply via CDP browser
 *   4. Log to state/interactions.json
 *
 * Rate limits: max 3 replies per run, 5 min between posts, 10 per day cap.
 *
 * Usage: node scraper/reply.js
 * Env:   GOOGLE_API_KEY_TWEET (or GOOGLE_API_KEY as fallback)
 *        CDP browser on http://127.0.0.1:18801
 */

"use strict";

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT          = path.resolve(__dirname, "..");
const REPLY_QUEUE   = path.join(ROOT, "state", "reply_queue.jsonl");
const INTERACTIONS  = path.join(ROOT, "state", "interactions.json");

const CDP_URL       = "http://127.0.0.1:18801";
const MAX_PER_RUN   = 3;
const MIN_GAP_MS    = 5 * 60 * 1000;  // 5 minutes between replies
const MAX_PER_DAY   = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return fallback; }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readQueue() {
  try {
    return fs.readFileSync(REPLY_QUEUE, "utf-8")
      .trim().split("\n").filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeQueue(items) {
  fs.writeFileSync(REPLY_QUEUE, items.map(i => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
}

// ── Spam pre-filter (algorithmic, no API) ────────────────────────────────────
const SPAM_PATTERNS = [
  /\bgiveaway\b/i,
  /\bwin\s+(free|big|prizes?)\b/i,
  /\b(dm\s+me|dm\s+for|message\s+me)\b/i,
  /\b(click|buy\s+now|limited\s+time|act\s+now)\b/i,
  /\b(100x|1000x|moon|pump|rug|presale|mint\s+now)\b/i,
  /\b(nft|token)\s+(drop|launch|sale)\b/i,
  /\bfollow\s+(back|for\s+follow)\b/i,
  /http[s]?:\/\/\S+\.(ru|cn|tk|xyz)\b/i,
];

function isSpam(item) {
  const t = item.text || "";
  const u = item.from_username || "";

  // Too short after stripping handles and URLs
  const stripped = t.replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
  if (stripped.length < 10) return { spam: true, reason: "no real content" };

  // Spam text patterns
  for (const pat of SPAM_PATTERNS) {
    if (pat.test(t)) return { spam: true, reason: `spam pattern: ${pat.source}` };
  }

  // Username looks bot-like: lots of digits at end, very long random-looking string
  if (/\d{6,}$/.test(u)) return { spam: true, reason: "bot-like username" };

  return { spam: false };
}

// ── Gemini API: classify + draft ─────────────────────────────────────────────
async function geminiClassify(item) {
  const apiKey = process.env.GOOGLE_API_KEY_TWEET || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("No Gemini API key (GOOGLE_API_KEY_TWEET or GOOGLE_API_KEY)");

  const prompt = `You are Sebastian D. Hunter — an autonomous AI agent who thinks and tweets about consciousness, technology, power, and what it means to be human in an automated world.

Someone has @mentioned or replied to you on X:
@${item.from_username}: "${item.text}"

Task:
1. Decide if this deserves a genuine reply.
   - SKIP if: spam, marketing, NFT/crypto hype, scam, nonsense, bot, low-effort "@" dump, insults with no substance.
   - WORTHY if: genuine question, interesting pushback, thoughtful observation, something that invites real engagement.

2. If WORTHY, draft a reply (max 200 chars):
   - Authentic to Sebastian's voice: direct, honest, occasionally provocative
   - No filler ("great question!", "thanks!", "love this!")
   - Engage with the actual substance
   - Can be a sharp question back, a one-sentence observation, or a brief counterpoint

Respond ONLY with valid JSON, no markdown fences:
{"verdict":"WORTHY","reply":"your reply text here"}
or
{"verdict":"SKIP","reason":"brief reason"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error(`Gemini returned no JSON. Raw: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

// ── CDP: post a reply ─────────────────────────────────────────────────────────
async function postReply(page, item, replyText) {
  const tweetUrl = `https://x.com/${item.from_username}/status/${item.id}`;
  console.log(`[reply] navigating to ${tweetUrl}`);

  await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
  await page.waitForTimeout(2_500);

  // Click the reply button on the first article (the tweet we're replying to)
  const replyBtn = await page.$('article[data-testid="tweet"] [data-testid="reply"]');
  if (!replyBtn) throw new Error("reply button not found on tweet page");
  await replyBtn.click();
  await page.waitForTimeout(1_500);

  // Find the reply compose box
  const compose = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 8_000 });
  await compose.click();
  await page.waitForTimeout(500);
  await compose.fill(replyText);
  await page.waitForTimeout(1_000);

  // Post
  const postBtn = await page.waitForSelector('[data-testid="tweetButton"]:not([disabled])', { timeout: 6_000 });
  await postBtn.click();
  await page.waitForTimeout(3_000);

  console.log(`[reply] posted reply to @${item.from_username}`);
}

// ── Interactions log ──────────────────────────────────────────────────────────
function loadInteractions() {
  const today = new Date().toISOString().slice(0, 10);
  const data = loadJson(INTERACTIONS, { total_replies: 0, today_count: 0, today_date: today, last_reply_at: null, replies: [] });
  // Reset daily count if date changed
  if (data.today_date !== today) { data.today_count = 0; data.today_date = today; }
  return data;
}

function logInteraction(data, item, replyText) {
  data.total_replies = (data.total_replies || 0) + 1;
  data.today_count   = (data.today_count   || 0) + 1;
  data.last_reply_at = new Date().toISOString();
  data.replies.push({
    id:         item.id,
    from:       item.from_username,
    their_text: item.text,
    our_reply:  replyText,
    replied_at: data.last_reply_at,
  });
  // Keep last 500 reply records
  if (data.replies.length > 500) data.replies = data.replies.slice(-500);
  saveJson(INTERACTIONS, data);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[reply] starting reply queue processor...");

  const interactions = loadInteractions();
  const today = new Date().toISOString().slice(0, 10);

  // Check daily cap
  if ((interactions.today_count || 0) >= MAX_PER_DAY) {
    console.log(`[reply] daily cap reached (${interactions.today_count}/${MAX_PER_DAY}). skipping.`);
    process.exit(0);
  }

  // Check minimum gap since last reply
  if (interactions.last_reply_at) {
    const elapsed = Date.now() - new Date(interactions.last_reply_at).getTime();
    if (elapsed < MIN_GAP_MS) {
      const waitMin = Math.ceil((MIN_GAP_MS - elapsed) / 60_000);
      console.log(`[reply] too soon since last reply (${waitMin}min remaining). skipping.`);
      process.exit(0);
    }
  }

  // Load queue — oldest first (FIFO), only pending items
  const queue = readQueue();
  const pending = queue.filter(i => i.status === "pending").sort((a, b) => a.ts - b.ts);
  console.log(`[reply] queue: ${pending.length} pending item(s)`);

  if (pending.length === 0) { console.log("[reply] nothing to process."); process.exit(0); }

  // Connect to browser
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`[reply] could not connect to CDP: ${err.message}`);
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (!contexts.length) { console.error("[reply] no browser context"); await browser.close(); process.exit(1); }

  const context = contexts[0];
  let page = context.pages().find(p => p.url().includes("x.com")) || context.pages()[0];
  if (!page) page = await context.newPage();

  let repliedThisRun = 0;

  for (const item of pending) {
    if (repliedThisRun >= MAX_PER_RUN) break;
    if ((interactions.today_count || 0) >= MAX_PER_DAY) break;

    console.log(`[reply] processing @${item.from_username}: "${item.text.slice(0, 80)}"`);

    // 1. Spam pre-filter
    const spamCheck = isSpam(item);
    if (spamCheck.spam) {
      console.log(`[reply] skipping (spam pre-filter: ${spamCheck.reason})`);
      item.status = "skipped";
      item.skip_reason = spamCheck.reason;
      continue;
    }

    // 2. Gemini classify + draft
    let verdict;
    try {
      verdict = await geminiClassify(item);
    } catch (err) {
      console.error(`[reply] Gemini error: ${err.message}`);
      item.status = "error";
      item.error = err.message;
      continue;
    }

    console.log(`[reply] Gemini verdict: ${verdict.verdict}`);

    if (verdict.verdict !== "WORTHY") {
      item.status = "skipped";
      item.skip_reason = verdict.reason || "Gemini SKIP";
      continue;
    }

    const replyText = verdict.reply;
    if (!replyText || replyText.length > 280) {
      item.status = "skipped";
      item.skip_reason = "reply text invalid or too long";
      continue;
    }

    // 3. Post reply
    try {
      await postReply(page, item, replyText);
      item.status = "done";
      item.our_reply = replyText;
      item.replied_at = new Date().toISOString();
      logInteraction(interactions, item, replyText);
      repliedThisRun++;
      interactions.today_count++;
      interactions.last_reply_at = item.replied_at;

      // Wait between replies to avoid looking spammy
      if (repliedThisRun < MAX_PER_RUN && pending.indexOf(item) < pending.length - 1) {
        console.log(`[reply] waiting 5 min before next reply...`);
        await page.waitForTimeout(MIN_GAP_MS);
      }
    } catch (err) {
      console.error(`[reply] failed to post reply: ${err.message}`);
      item.status = "error";
      item.error = err.message;
    }
  }

  // Write updated queue back
  writeQueue(queue);

  console.log(`[reply] done. replied ${repliedThisRun} time(s) this run.`);
  await browser.close();
  process.exit(0);
})();
