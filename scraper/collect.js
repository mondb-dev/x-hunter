#!/usr/bin/env node
/**
 * scraper/collect.js — AI-free X feed collector
 *
 * Connects to the existing x-hunter Chrome instance via CDP (port 18801),
 * scrapes the timeline, scores posts using HN-gravity + trust + ontology
 * alignment, deduplicates against seen_ids, then writes:
 *
 *   state/feed_buffer.jsonl  — raw JSONL records (append)
 *   state/feed_digest.txt    — compact human+AI-readable digest (append)
 *   state/seen_ids.json      — bloom-lite dedup set (rolling 10k window)
 *
 * Usage:  node scraper/collect.js
 */

"use strict";

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT         = path.resolve(__dirname, "..");
const ONTOLOGY     = path.join(ROOT, "state", "ontology.json");
const TRUST_GRAPH  = path.join(ROOT, "state", "trust_graph.json");
const SEEN_IDS     = path.join(ROOT, "state", "seen_ids.json");
const FEED_BUFFER  = path.join(ROOT, "state", "feed_buffer.jsonl");
const FEED_DIGEST  = path.join(ROOT, "state", "feed_digest.txt");

const CDP_URL      = "http://127.0.0.1:18801";
const MAX_SEEN     = 10000;   // rolling window — drop oldest when full
const TOP_POSTS    = 25;      // posts to keep per run
const TOP_REPLIES  = 3;       // top replies to fetch per post

// ── Load state ────────────────────────────────────────────────────────────────
function loadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return fallback; }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

// HN gravity: score = engagement / (age_hours + 2)^1.8
function gravityScore(engagement, tsMs) {
  const ageHours = Math.max(0, (Date.now() - tsMs) / 3_600_000);
  return engagement / Math.pow(ageHours + 2, 1.8);
}

// BM25-lite: keyword overlap between post text and ontology axis labels
function ontologyScore(text, axes) {
  if (!axes || axes.length === 0) return 0;
  const words = text.toLowerCase().split(/\W+/);
  let hits = 0;
  for (const axis of axes) {
    const axisWords = (axis.label || axis.name || "").toLowerCase().split(/\W+/);
    for (const aw of axisWords) {
      if (aw.length > 3 && words.includes(aw)) hits++;
    }
  }
  return hits;
}

// Trust score from trust_graph (0–10)
function trustScore(username, trustGraph) {
  const acct = trustGraph.accounts?.[username.toLowerCase()];
  if (!acct) return 0;
  return Math.min(10, acct.trust_score ?? acct.score ?? 3);
}

// ── Parse engagement counts like "1.2K", "34", "1M" ─────────────────────────
function parseCount(str) {
  if (!str) return 0;
  const s = str.replace(/,/g, "").trim();
  if (s.endsWith("K")) return parseFloat(s) * 1_000;
  if (s.endsWith("M")) return parseFloat(s) * 1_000_000;
  return parseInt(s) || 0;
}

// ── DOM extraction (runs inside browser page context) ────────────────────────
async function extractPosts(page) {
  return page.evaluate(() => {
    const results = [];

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const art of articles) {
      try {
        // Tweet ID from permalink
        const link = art.querySelector('a[href*="/status/"]');
        if (!link) continue;
        const match = link.href.match(/\/status\/(\d+)/);
        if (!match) continue;
        const id = match[1];

        // Author
        const userEl = art.querySelector('[data-testid="User-Name"]');
        const usernameEl = userEl?.querySelector('a[href^="/"]');
        const username = usernameEl?.href?.split("/").pop() || "";
        const displayName = userEl?.querySelector('span')?.innerText || username;

        // Text
        const textEl = art.querySelector('[data-testid="tweetText"]');
        const text = textEl?.innerText || "";

        // Timestamp
        const timeEl = art.querySelector("time");
        const ts = timeEl ? new Date(timeEl.getAttribute("datetime")).getTime() : Date.now();

        // Engagement
        const likeEl   = art.querySelector('[data-testid="like"]');
        const rtEl     = art.querySelector('[data-testid="retweet"]');
        const replyEl  = art.querySelector('[data-testid="reply"]');
        const viewEl   = art.querySelector('[data-testid="app-text-transition-container"]');

        const likes   = likeEl?.innerText   || "0";
        const rts     = rtEl?.innerText     || "0";
        const replies = replyEl?.innerText  || "0";
        const views   = viewEl?.innerText   || "0";

        // Is reply?
        const isReply = !!art.querySelector('[data-testid="tweet"] [data-testid="tweet"]');

        results.push({ id, username, displayName, text, ts, likes, rts, replies, views, isReply });
      } catch (_) {
        // skip broken elements
      }
    }
    return results;
  });
}

// ── Fetch top replies for a tweet URL ─────────────────────────────────────────
async function fetchReplies(page, tweetUrl, topN) {
  try {
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8_000 });
    await page.waitForTimeout(1_500);

    const all = await extractPosts(page);
    // First article is the OP — rest are replies
    const replies = all.slice(1).filter(p => p.text.length > 0);

    // Sort by likes + rts descending, take topN
    return replies
      .sort((a, b) =>
        (parseCount(b.likes) + parseCount(b.rts)) -
        (parseCount(a.likes) + parseCount(a.rts))
      )
      .slice(0, topN);
  } catch {
    return [];
  }
}

// ── Compact text line for a post ─────────────────────────────────────────────
function formatPost(post, trustVal, velocityVal) {
  const v = velocityVal.toFixed(1);
  const t = trustVal;
  const likes = parseCount(post.likes);
  const rts   = parseCount(post.rts);
  const eng   = likes >= 1000 ? `${(likes/1000).toFixed(1)}k❤` : `${likes}❤`;
  const rtStr = rts  >= 1000 ? `${(rts/1000).toFixed(1)}k🔁` : `${rts}🔁`;
  return `@${post.username} [v${v} T${t}] "${post.text.replace(/\n+/g, " ").slice(0, 200)}" [${eng} ${rtStr}]`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[scraper] starting collect run...");

  // Load state
  const ontology   = loadJson(ONTOLOGY, { axes: [] });
  const trustGraph = loadJson(TRUST_GRAPH, { accounts: {} });
  const seenData   = loadJson(SEEN_IDS, { ids: [] });
  const seenSet    = new Set(seenData.ids);

  // Connect to existing Chrome on CDP port
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`[scraper] could not connect to CDP at ${CDP_URL}: ${err.message}`);
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (!contexts.length) {
    console.error("[scraper] no browser context found");
    await browser.close();
    process.exit(1);
  }

  const context = contexts[0];
  // Use existing tab or open a new one
  let page = context.pages().find(p => p.url().includes("x.com")) || context.pages()[0];
  if (!page) page = await context.newPage();

  // ── Step 1: navigate to home feed ─────────────────────────────────────────
  try {
    if (!page.url().includes("x.com/home")) {
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
    await page.waitForTimeout(2_000); // let lazy content load
  } catch (err) {
    console.error(`[scraper] failed to load feed: ${err.message}`);
    await browser.close();
    process.exit(1);
  }

  // ── Step 2: scroll to collect more posts ──────────────────────────────────
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1_200);
  }

  // ── Step 3: extract and score ─────────────────────────────────────────────
  const raw = await extractPosts(page);
  console.log(`[scraper] extracted ${raw.length} raw posts`);

  const scored = [];
  for (const post of raw) {
    if (!post.text || seenSet.has(post.id)) continue;

    const engagement = parseCount(post.likes) + parseCount(post.rts) * 2 + parseCount(post.replies);
    const velocity   = gravityScore(engagement, post.ts);
    const trust      = trustScore(post.username, trustGraph);
    const alignment  = ontologyScore(post.text, ontology.axes);
    const total      = velocity + trust * 0.5 + alignment * 0.3;

    scored.push({ ...post, velocity, trust, alignment, total });
  }

  // Sort by total score, take top posts
  scored.sort((a, b) => b.total - a.total);
  const selected = scored.slice(0, TOP_POSTS);
  console.log(`[scraper] selected ${selected.length} posts after dedup+scoring`);

  // ── Step 4: fetch top replies for highest-scoring posts ───────────────────
  const withReplies = [];
  for (const post of selected.slice(0, 8)) {
    const url = `https://x.com/${post.username}/status/${post.id}`;
    const replies = await fetchReplies(page, url, TOP_REPLIES);
    withReplies.push({ ...post, topReplies: replies });
    // Mark replies as seen too
    for (const r of replies) seenSet.add(r.id);
  }
  // Remaining posts (no replies fetched)
  for (const post of selected.slice(8)) {
    withReplies.push({ ...post, topReplies: [] });
  }

  // ── Step 5: mark all as seen ──────────────────────────────────────────────
  for (const post of withReplies) seenSet.add(post.id);

  // Rolling window — keep only last MAX_SEEN
  const seenArr = Array.from(seenSet);
  const trimmed = seenArr.length > MAX_SEEN ? seenArr.slice(seenArr.length - MAX_SEEN) : seenArr;
  saveJson(SEEN_IDS, { ids: trimmed, updated_at: new Date().toISOString() });

  // ── Step 6: write JSONL buffer ────────────────────────────────────────────
  const bufferLines = withReplies.map(post => JSON.stringify({
    id:       post.id,
    ts:       post.ts,
    ts_iso:   new Date(post.ts).toISOString(),
    u:        post.username,
    dn:       post.displayName,
    text:     post.text,
    likes:    parseCount(post.likes),
    rts:      parseCount(post.rts),
    replies:  parseCount(post.replies),
    velocity: parseFloat(post.velocity.toFixed(2)),
    trust:    post.trust,
    score:    parseFloat(post.total.toFixed(2)),
    top_replies: post.topReplies.map(r => ({
      id: r.id, u: r.username, text: r.text,
      likes: parseCount(r.likes), rts: parseCount(r.rts),
    })),
  }));
  fs.appendFileSync(FEED_BUFFER, bufferLines.join("\n") + "\n");

  // ── Step 7: write compact digest ─────────────────────────────────────────
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const digestLines = [`\n── ${now} ──────────────────────────────────`];

  for (const post of withReplies) {
    digestLines.push(formatPost(post, post.trust, post.velocity));
    for (const r of post.topReplies) {
      const rEng = parseCount(r.likes);
      const rEngStr = rEng >= 1000 ? `${(rEng/1000).toFixed(1)}k❤` : `${rEng}❤`;
      digestLines.push(`  > @${r.username}: "${r.text.replace(/\n+/g, " ").slice(0, 150)}" [${rEngStr}]`);
    }
  }

  fs.appendFileSync(FEED_DIGEST, digestLines.join("\n") + "\n");

  console.log(`[scraper] wrote ${withReplies.length} posts to buffer+digest`);

  await browser.close();
  process.exit(0);
})();
