#!/usr/bin/env node
/**
 * scraper/collect.js — AI-free X feed collector
 *
 * Connects to the existing x-hunter Chrome instance via CDP (port 18801),
 * scrapes the timeline, scores posts with HN-gravity + trust + ontology
 * alignment, deduplicates against seen_ids, extracts keyphrases via RAKE,
 * then writes:
 *
 *   state/index.db           — SQLite FTS5 index (posts + keywords)
 *   state/feed_buffer.jsonl  — raw JSONL records (append)
 *   state/feed_digest.txt    — compact scored+keyword digest (append)
 *   state/seen_ids.json      — dedup set (rolling 10k window)
 *
 * Usage:  node scraper/collect.js
 */

"use strict";

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");
const db   = require("./db");

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT         = path.resolve(__dirname, "..");
const ONTOLOGY     = path.join(ROOT, "state", "ontology.json");
const TRUST_GRAPH  = path.join(ROOT, "state", "trust_graph.json");
const SEEN_IDS     = path.join(ROOT, "state", "seen_ids.json");
const FEED_BUFFER  = path.join(ROOT, "state", "feed_buffer.jsonl");
const FEED_DIGEST  = path.join(ROOT, "state", "feed_digest.txt");

const REPLY_QUEUE  = path.join(ROOT, "state", "reply_queue.jsonl");

const CDP_URL      = "http://127.0.0.1:18801";
const MAX_SEEN     = 10000;
const TOP_POSTS    = 25;
const TOP_REPLIES  = 5;

// ── Load state ────────────────────────────────────────────────────────────────
function loadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return fallback; }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── RAKE keyword extractor ────────────────────────────────────────────────────
// Rapid Automatic Keyword Extraction — extracts scored multi-word keyphrases.
// No external deps. Works by splitting on stop words, scoring by degree/freq.

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","this","that",
  "these","those","it","its","he","she","they","we","you","i","my","your",
  "our","their","not","no","so","if","as","up","out","about","just","also",
  "than","then","when","where","who","what","how","all","more","most","some",
  "can","into","over","after","before","between","such","even","very","only",
  "well","still","here","there","now","get","got","like","been","never","one",
  "two","its","re","s","t","ve","ll","d","m","don","isn","aren","wasn","weren",
  "because","them","him","her","us","which","while","through","down","each",
]);

function extractKeywords(text, topN = 8) {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")      // strip URLs
    .replace(/[@#]\w+/g, "")             // strip @handles and #tags
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Build candidate phrases: consecutive non-stop-word runs
  const phrases = [];
  let current = [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || /^\d+$/.test(word)) {
      if (current.length > 0) { phrases.push(current.slice()); current = []; }
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) phrases.push(current);

  // Word frequency and co-occurrence degree
  const freq = {}, degree = {};
  for (const phrase of phrases) {
    for (const word of phrase) {
      freq[word]   = (freq[word]   || 0) + 1;
      degree[word] = (degree[word] || 0) + phrase.length - 1;
    }
  }

  // RAKE word score: (degree + freq) / freq
  const wordScore = {};
  for (const word of Object.keys(freq)) {
    wordScore[word] = (degree[word] + freq[word]) / freq[word];
  }

  // Phrase score = sum of member word scores
  const seen = new Set();
  return phrases
    .map(phrase => ({ phrase: phrase.join(" "), score: phrase.reduce((s, w) => s + wordScore[w], 0) }))
    .filter(p => { if (seen.has(p.phrase)) return false; seen.add(p.phrase); return p.phrase.length > 2; })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(p => p.phrase);
}

// ── Scoring helpers ───────────────────────────────────────────────────────────
function gravityScore(engagement, tsMs) {
  const ageHours = Math.max(0, (Date.now() - tsMs) / 3_600_000);
  return engagement / Math.pow(ageHours + 2, 1.8);
}

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

function trustScore(username, trustGraph) {
  const acct = trustGraph.accounts?.[username.toLowerCase()];
  if (!acct) return 0;
  return Math.min(10, acct.trust_score ?? acct.score ?? 3);
}

function parseCount(str) {
  if (!str) return 0;
  const s = str.replace(/,/g, "").trim();
  if (s.endsWith("K")) return parseFloat(s) * 1_000;
  if (s.endsWith("M")) return parseFloat(s) * 1_000_000;
  return parseInt(s) || 0;
}

// ── DOM extraction ────────────────────────────────────────────────────────────
async function extractPosts(page) {
  return page.evaluate(() => {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const art of articles) {
      try {
        const link = art.querySelector('a[href*="/status/"]');
        if (!link) continue;
        const match = link.href.match(/\/status\/(\d+)/);
        if (!match) continue;
        const id = match[1];

        const userEl      = art.querySelector('[data-testid="User-Name"]');
        const usernameEl  = userEl?.querySelector('a[href^="/"]');
        const username    = usernameEl?.href?.split("/").pop() || "";
        const displayName = userEl?.querySelector('span')?.innerText || username;

        const textEl  = art.querySelector('[data-testid="tweetText"]');
        const text    = textEl?.innerText || "";

        const timeEl  = art.querySelector("time");
        const ts      = timeEl ? new Date(timeEl.getAttribute("datetime")).getTime() : Date.now();

        const likes   = art.querySelector('[data-testid="like"]')?.innerText    || "0";
        const rts     = art.querySelector('[data-testid="retweet"]')?.innerText || "0";
        const replies = art.querySelector('[data-testid="reply"]')?.innerText   || "0";

        results.push({ id, username, displayName, text, ts, likes, rts, replies });
      } catch (_) {}
    }
    return results;
  });
}

async function fetchReplies(page, tweetUrl, topN) {
  try {
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8_000 });
    await page.waitForTimeout(1_500);
    const all = await extractPosts(page);
    return all
      .slice(1)
      .filter(p => p.text.length > 0)
      .sort((a, b) =>
        (parseCount(b.likes) + parseCount(b.rts)) -
        (parseCount(a.likes) + parseCount(a.rts))
      )
      .slice(0, topN);
  } catch {
    return [];
  }
}

// ── Compact digest formatting ─────────────────────────────────────────────────
function formatPost(post, trustVal, velocityVal, keywords) {
  const v   = velocityVal.toFixed(1);
  const likes = parseCount(post.likes);
  const rts   = parseCount(post.rts);
  const eng   = likes >= 1000 ? `${(likes/1000).toFixed(1)}k❤` : `${likes}❤`;
  const rtStr = rts   >= 1000 ? `${(rts/1000).toFixed(1)}k🔁`  : `${rts}🔁`;
  const kwStr = keywords.length ? `  {${keywords.slice(0,4).join(", ")}}` : "";
  return `@${post.username} [v${v} T${trustVal}] "${post.text.replace(/\n+/g, " ").slice(0, 200)}"` +
         ` [${eng} ${rtStr}]${kwStr}`;
}

// ── Notifications / mentions scraper ─────────────────────────────────────────
// Navigates to x.com/notifications (Mentions tab), extracts reply/mention
// tweets not already in reply_queue.jsonl, and appends them as pending items.
async function scrapeNotifications(page) {
  console.log("[scraper] checking notifications/mentions...");

  // Load IDs already queued to avoid duplicates
  const existingIds = new Set();
  try {
    const raw = fs.readFileSync(REPLY_QUEUE, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of raw) {
      try { existingIds.add(JSON.parse(line).id); } catch {}
    }
  } catch {}

  try {
    await page.goto("https://x.com/notifications", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(2_000);

    // Click the Mentions tab if it exists
    try {
      const tabs = await page.$$('[role="tab"]');
      for (const tab of tabs) {
        const label = await tab.innerText().catch(() => "");
        if (/mentions/i.test(label)) { await tab.click(); await page.waitForTimeout(1_500); break; }
      }
    } catch {}

    // Scroll once to load more
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1_000);

    const mentions = await extractPosts(page);
    const newItems = [];

    for (const m of mentions) {
      if (!m.text || !m.id || existingIds.has(m.id)) continue;
      // Skip posts with essentially no text content (just handles/URLs)
      const stripped = m.text.replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
      if (stripped.length < 8) continue;

      newItems.push(JSON.stringify({
        id:            m.id,
        ts:            m.ts,
        ts_iso:        new Date(m.ts).toISOString(),
        from_username: m.username,
        text:          m.text,
        queued_at:     new Date().toISOString(),
        status:        "pending",
      }));
      existingIds.add(m.id);
    }

    if (newItems.length > 0) {
      fs.appendFileSync(REPLY_QUEUE, newItems.join("\n") + "\n");
    }
    console.log(`[scraper] notifications: queued ${newItems.length} new mention(s)`);
  } catch (err) {
    console.error(`[scraper] notifications scrape failed: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[scraper] starting collect run...");

  const ontology   = loadJson(ONTOLOGY, { axes: [] });
  const trustGraph = loadJson(TRUST_GRAPH, { accounts: {} });
  const seenData   = loadJson(SEEN_IDS, { ids: [] });
  const seenSet    = new Set(seenData.ids);

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
  let page = context.pages().find(p => p.url().includes("x.com")) || context.pages()[0];
  if (!page) page = await context.newPage();

  // Navigate to home feed
  try {
    if (!page.url().includes("x.com/home")) {
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
    await page.waitForTimeout(2_000);
  } catch (err) {
    console.error(`[scraper] failed to load feed: ${err.message}`);
    await browser.close();
    process.exit(1);
  }

  // Scroll to load more posts
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1_200);
  }

  // Extract and score
  const raw = await extractPosts(page);
  console.log(`[scraper] extracted ${raw.length} raw posts`);

  const scored = [];
  for (const post of raw) {
    if (!post.text || seenSet.has(post.id)) continue;
    const engagement = parseCount(post.likes) + parseCount(post.rts) * 2 + parseCount(post.replies);
    const velocity   = gravityScore(engagement, post.ts);
    const trust      = trustScore(post.username, trustGraph);
    const alignment  = ontologyScore(post.text, ontology.axes);
    const keywords   = extractKeywords(post.text);
    const total      = velocity + trust * 0.5 + alignment * 0.3;
    scored.push({ ...post, velocity, trust, alignment, keywords, total });
  }

  scored.sort((a, b) => b.total - a.total);
  const selected = scored.slice(0, TOP_POSTS);
  console.log(`[scraper] selected ${selected.length} posts after dedup+scoring`);

  // Fetch top replies for highest-scoring posts
  const withReplies = [];
  for (const post of selected.slice(0, 8)) {
    const url = `https://x.com/${post.username}/status/${post.id}`;
    const replies = await fetchReplies(page, url, TOP_REPLIES);
    withReplies.push({ ...post, topReplies: replies });
    for (const r of replies) seenSet.add(r.id);
  }
  for (const post of selected.slice(8)) {
    withReplies.push({ ...post, topReplies: [] });
  }

  // Mark seen
  for (const post of withReplies) seenSet.add(post.id);
  const seenArr = Array.from(seenSet);
  const trimmed = seenArr.length > MAX_SEEN ? seenArr.slice(seenArr.length - MAX_SEEN) : seenArr;
  saveJson(SEEN_IDS, { ids: trimmed, updated_at: new Date().toISOString() });

  // ── Write SQLite index ────────────────────────────────────────────────────
  const scrapedAt = Date.now();
  for (const post of withReplies) {
    db.insertPost({
      id:          post.id,
      ts:          post.ts,
      ts_iso:      new Date(post.ts).toISOString(),
      username:    post.username,
      display_name: post.displayName,
      text:        post.text,
      likes:       parseCount(post.likes),
      rts:         parseCount(post.rts),
      replies:     parseCount(post.replies),
      velocity:    post.velocity,
      trust:       post.trust,
      score:       post.total,
      keywords:    post.keywords.join(", "),
      scraped_at:  scrapedAt,
    });
    for (const kw of post.keywords) {
      db.insertKeyword({ post_id: post.id, keyword: kw, score: post.total });
    }
    for (const r of post.topReplies) {
      const rkw = extractKeywords(r.text);
      db.insertPost({
        id:          r.id,
        ts:          r.ts,
        ts_iso:      new Date(r.ts).toISOString(),
        username:    r.username,
        display_name: r.displayName || r.username,
        text:        r.text,
        likes:       parseCount(r.likes),
        rts:         parseCount(r.rts),
        replies:     0,
        velocity:    gravityScore(parseCount(r.likes), r.ts),
        trust:       trustScore(r.username, trustGraph),
        score:       parseCount(r.likes) * 0.1,
        keywords:    rkw.join(", "),
        scraped_at:  scrapedAt,
        parent_id:   post.id,
      });
      for (const kw of rkw) {
        db.insertKeyword({ post_id: r.id, keyword: kw, score: parseCount(r.likes) * 0.1 });
      }
    }
  }

  // ── Write JSONL buffer ────────────────────────────────────────────────────
  const bufferLines = withReplies.map(post => JSON.stringify({
    id: post.id, ts: post.ts, ts_iso: new Date(post.ts).toISOString(),
    u: post.username, dn: post.displayName, text: post.text,
    likes: parseCount(post.likes), rts: parseCount(post.rts),
    replies: parseCount(post.replies),
    velocity: parseFloat(post.velocity.toFixed(2)),
    trust: post.trust, score: parseFloat(post.total.toFixed(2)),
    keywords: post.keywords,
    top_replies: post.topReplies.map(r => ({
      id: r.id, u: r.username, text: r.text,
      likes: parseCount(r.likes), rts: parseCount(r.rts),
    })),
  }));
  fs.appendFileSync(FEED_BUFFER, bufferLines.join("\n") + "\n");

  // ── Write compact digest ──────────────────────────────────────────────────
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const digestLines = [`\n── ${now} ──────────────────────────────────`];
  for (const post of withReplies) {
    digestLines.push(formatPost(post, post.trust, post.velocity, post.keywords));
    for (const r of post.topReplies) {
      const rEng = parseCount(r.likes);
      const rEngStr = rEng >= 1000 ? `${(rEng/1000).toFixed(1)}k❤` : `${rEng}❤`;
      digestLines.push(`  > @${r.username}: "${r.text.replace(/\n+/g, " ").slice(0, 150)}" [${rEngStr}]`);
    }
  }
  fs.appendFileSync(FEED_DIGEST, digestLines.join("\n") + "\n");

  console.log(`[scraper] wrote ${withReplies.length} posts to index+buffer+digest`);

  // ── Scrape notifications / mentions → reply queue ─────────────────────────
  await scrapeNotifications(page);

  await browser.close();
  process.exit(0);
})();
