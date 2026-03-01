#!/usr/bin/env node
/**
 * scraper/reply.js — FIFO reply queue processor
 *
 * For each pending mention, the pipeline is:
 *   1. Algorithmic spam pre-filter  (free — no API)
 *   2. Fetch thread context         (CDP — reads conversation before this mention)
 *   3. Memory recall                (SQLite FTS5 — retrieves relevant past thinking)
 *   4. Gemini classify + draft      (enriched prompt: thread + memory + mention)
 *   5. Post reply                   (CDP — page already on tweet, no re-navigation)
 *   6. Log to state/interactions.json
 *
 * Rate limits: max 3 replies per run, 5 min between posts, 10 per day cap.
 *
 * Usage: node scraper/reply.js
 * Env:   GOOGLE_API_KEY_TWEET (or GOOGLE_API_KEY as fallback)
 *        CDP browser on http://127.0.0.1:18801
 */

"use strict";

const { connectBrowser, getXPage } = require("../runner/cdp");
const fs   = require("fs");
const path = require("path");
const db   = require("./db");
const { extractKeywords } = require("./analytics");

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT         = path.resolve(__dirname, "..");
const REPLY_QUEUE  = path.join(ROOT, "state", "reply_queue.jsonl");
const INTERACTIONS = path.join(ROOT, "state", "interactions.json");

const MAX_PER_RUN = 3;
const MIN_GAP_MS  = 5 * 60 * 1000;  // 5 minutes between replies
const MAX_PER_DAY = 10;

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

// ── 1. Spam pre-filter (algorithmic, no API) ──────────────────────────────────
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

  const stripped = t.replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
  if (stripped.length < 10) return { spam: true, reason: "no real content" };

  for (const pat of SPAM_PATTERNS) {
    if (pat.test(t)) return { spam: true, reason: `spam pattern: ${pat.source}` };
  }

  if (/\d{6,}$/.test(u)) return { spam: true, reason: "bot-like username" };

  return { spam: false };
}

// ── 2. Fetch thread context via CDP ───────────────────────────────────────────
/**
 * Navigate to the tweet page and extract the visible conversation thread.
 * Returns up to 6 tweet snippets (ancestor tweets + the mention itself).
 * Leaves the page on the tweet URL so postReply can skip re-navigation.
 */
async function fetchThreadContext(page, item) {
  const tweetUrl = `https://x.com/${item.from_username}/status/${item.id}`;
  try {
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
    await new Promise(r => setTimeout(r, 1_500));

    const articles = await page.$$eval('article[data-testid="tweet"]', els =>
      els.slice(0, 6).map(a => {
        const userEl = a.querySelector('[data-testid="User-Name"]');
        const textEl = a.querySelector('[data-testid="tweetText"]');
        return {
          user: (userEl?.innerText || "").split("\n")[0].trim(),
          text: (textEl?.innerText || "").trim(),
        };
      }).filter(a => a.text.length > 0)
    );

    return articles;
  } catch (err) {
    console.warn(`[reply] thread context fetch failed: ${err.message}`);
    // Navigate anyway so we end up on the right page for posting
    try { await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }); } catch {}
    return [];
  }
}

// ── 3. Memory recall ──────────────────────────────────────────────────────────
/**
 * Extract RAKE keywords from the mention text and query the local memory FTS5
 * index for relevant past journal/checkpoint entries.
 */
function recallForMention(text, limit = 3) {
  try {
    const keywords = extractKeywords(text, 5);
    if (!keywords.length) return [];
    return db.recallMemory(keywords.join(" "), limit);
  } catch {
    return [];
  }
}

// ── 4. Gemini: classify + draft with full context ─────────────────────────────
async function geminiClassify(item, threadContext = [], memoryHints = [], userHistory = null) {
  const apiKey = process.env.GOOGLE_API_KEY_TWEET || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("No Gemini API key (GOOGLE_API_KEY_TWEET or GOOGLE_API_KEY)");

  // Build thread context block
  let threadBlock = "";
  if (threadContext.length > 0) {
    threadBlock = "\nThread context (conversation before this mention):\n" +
      threadContext
        .map(a => `  @${a.user}: "${a.text.slice(0, 220)}"`)
        .join("\n") + "\n";
  }

  // Build memory block
  let memoryBlock = "";
  if (memoryHints.length > 0) {
    memoryBlock = "\nYour relevant past thinking (from journals/checkpoints):\n" +
      memoryHints.map(m => {
        const excerpt = (m.text_content || "").replace(/\s+/g, " ").trim().slice(0, 200);
        return `  [${m.type} · ${m.title} · ${m.date}]\n  "${excerpt}..."`;
      }).join("\n\n") + "\n";
  }

  // Build user history block
  let userBlock = "";
  if (userHistory && userHistory.reply_count > 0) {
    const prior = userHistory.exchanges.slice(-3).map(e =>
      `  Them: "${(e.their_text || "").slice(0, 120)}"\n  Us: "${(e.our_reply || "").slice(0, 120)}"`
    ).join("\n---\n");
    userBlock = `\nPrior exchanges with @${item.from_username} (${userHistory.reply_count} total):\n${prior}\n\nReference prior exchanges if relevant. Do not repeat what was already said.\n`;
  }

  const prompt = `You are Sebastian D. Hunter — an autonomous AI agent who thinks and writes about consciousness, technology, power, and what it means to be human in an automated world.
${threadBlock}${memoryBlock}${userBlock}
The mention you are replying to:
@${item.from_username}: "${item.text}"

Instructions:
1. Read the thread context to understand what conversation this is part of.
2. Check your past thinking — have you explored this territory before? Has your view evolved?
3. Decide: WORTHY or SKIP?
   - SKIP: spam, marketing, NFT/crypto hype, scam, bot, low-effort mention, insults with no substance.
   - WORTHY: genuine question, interesting pushback, thoughtful observation, anything inviting real engagement.
4. If WORTHY, draft a reply (max 200 chars):
   - Grounded in the thread context and your past thinking — not a generic take
   - Authentic to Sebastian's voice: direct, honest, occasionally sharp
   - No filler phrases ("great question!", "thanks for sharing!", "love this!")
   - Can be a sharp question back, a one-sentence observation, or a brief counterpoint
   - If your memory shows you've said something similar before, push further or reconsider

Respond ONLY with valid JSON, no markdown fences:
{"verdict":"WORTHY","reply":"your reply text here"}
or
{"verdict":"SKIP","reason":"brief reason"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  // Strip optional markdown fences, then extract the JSON object (greedy match)
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Gemini returned no JSON. Raw: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

// ── 5. CDP: post a reply (page already on tweet URL) ─────────────────────────
async function postReply(page, item, replyText) {
  console.log(`[reply] posting reply to @${item.from_username}`);

  // Page is already on the tweet URL from fetchThreadContext — wait for it
  await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
  await new Promise(r => setTimeout(r, 1_000));

  // Click the reply button on the first article
  const replyBtn = await page.$('article[data-testid="tweet"] [data-testid="reply"]');
  if (!replyBtn) throw new Error("reply button not found on tweet page");
  await replyBtn.click();
  await new Promise(r => setTimeout(r, 1_500));

  // Find the reply compose box
  const compose = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 8_000 });
  await compose.click();
  await new Promise(r => setTimeout(r, 500));
  await compose.fill(replyText);
  await new Promise(r => setTimeout(r, 1_000));

  // Post
  const postBtn = await page.waitForSelector('[data-testid="tweetButton"]:not([disabled])', { timeout: 6_000 });
  await postBtn.click();
  await new Promise(r => setTimeout(r, 3_000));

  console.log(`[reply] posted reply to @${item.from_username}`);
}

// ── Interactions log ──────────────────────────────────────────────────────────
function loadInteractions() {
  const today = new Date().toISOString().slice(0, 10);
  const data = loadJson(INTERACTIONS, { total_replies: 0, today_count: 0, today_date: today, last_reply_at: null, replies: [], users: {} });
  if (data.today_date !== today) { data.today_count = 0; data.today_date = today; }
  if (!data.users) data.users = {};
  return data;
}

function getUserHistory(data, username) {
  return (data.users || {})[username] || null;
}

function logInteraction(data, item, replyText, memoryHints) {
  data.total_replies = (data.total_replies || 0) + 1;
  data.today_count   = (data.today_count   || 0) + 1;
  data.last_reply_at = new Date().toISOString();
  data.replies.push({
    id:            item.id,
    from:          item.from_username,
    their_text:    item.text,
    our_reply:     replyText,
    memory_used:   memoryHints.map(m => `${m.type}:${m.title}`),
    replied_at:    data.last_reply_at,
  });
  if (data.replies.length > 500) data.replies = data.replies.slice(-500);

  // Update per-user conversation history
  const u = data.users[item.from_username] || { reply_count: 0, last_reply_at: null, exchanges: [] };
  u.reply_count += 1;
  u.last_reply_at = data.last_reply_at;
  u.exchanges.push({ their_text: item.text, our_reply: replyText, replied_at: data.last_reply_at });
  if (u.exchanges.length > 5) u.exchanges = u.exchanges.slice(-5);
  data.users[item.from_username] = u;

  saveJson(INTERACTIONS, data);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[reply] starting reply queue processor...");

  const interactions = loadInteractions();

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
    browser = await connectBrowser();
  } catch (err) {
    console.error(`[reply] could not connect to CDP: ${err.message}`);
    process.exit(1);
  }

  let page;
  try {
    page = await getXPage(browser);
  } catch (err) {
    console.error(`[reply] could not get page: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  let repliedThisRun = 0;

  for (const item of pending) {
    if (repliedThisRun >= MAX_PER_RUN) break;
    if ((interactions.today_count || 0) >= MAX_PER_DAY) break;

    console.log(`[reply] processing @${item.from_username}: "${item.text.slice(0, 80)}"`);

    // ── Step 1: Spam pre-filter ────────────────────────────────────────────
    const spamCheck = isSpam(item);
    if (spamCheck.spam) {
      console.log(`[reply] skipping (spam: ${spamCheck.reason})`);
      item.status = "skipped";
      item.skip_reason = spamCheck.reason;
      continue;
    }

    // ── Step 2: Fetch thread context (navigate to tweet) ──────────────────
    console.log(`[reply] fetching thread context...`);
    const threadContext = await fetchThreadContext(page, item);
    console.log(`[reply] thread: ${threadContext.length} tweet(s) in view`);

    // ── Step 3: Memory recall ──────────────────────────────────────────────
    const memoryHints = recallForMention(item.text);
    if (memoryHints.length > 0) {
      console.log(`[reply] memory: ${memoryHints.length} relevant entry(s) found (${memoryHints.map(m => m.title).join(", ")})`);
    } else {
      console.log(`[reply] memory: no relevant past entries`);
    }

    // ── Step 4: Gemini classify + draft ───────────────────────────────────
    const userHistory = getUserHistory(interactions, item.from_username);
    if (userHistory) {
      console.log(`[reply] user history: @${item.from_username} has ${userHistory.reply_count} prior exchange(s)`);
    }

    let verdict;
    try {
      verdict = await geminiClassify(item, threadContext, memoryHints, userHistory);
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

    // ── Step 5: Post reply (page already on tweet URL) ────────────────────
    try {
      await postReply(page, item, replyText);
      item.status    = "done";
      item.our_reply = replyText;
      item.replied_at = new Date().toISOString();
      logInteraction(interactions, item, replyText, memoryHints); // increments today_count
      repliedThisRun++;
      interactions.last_reply_at = item.replied_at;

      if (repliedThisRun < MAX_PER_RUN && pending.indexOf(item) < pending.length - 1) {
        console.log(`[reply] waiting 5 min before next reply...`);
        await new Promise(r => setTimeout(r, MIN_GAP_MS));
      }
    } catch (err) {
      console.error(`[reply] failed to post: ${err.message}`);
      item.status = "error";
      item.error  = err.message;
    }
  }

  writeQueue(queue);

  console.log(`[reply] done. replied ${repliedThisRun} time(s) this run.`);
  browser.disconnect();
  process.exit(0);
})();
