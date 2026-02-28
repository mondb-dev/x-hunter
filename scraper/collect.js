#!/usr/bin/env node
/**
 * scraper/collect.js — AI-free X feed collector (analytics-enhanced)
 *
 * Pipeline:
 *   1. CDP → extract raw posts via DOM
 *   2. sanitizePost()          — filter ads, short, emoji-spam, non-English
 *   3. seenSet dedup           — skip already-indexed post IDs
 *   4. RAKE keyword extraction + base scoring (velocity + trust + alignment)
 *   5. deduplicateByJaccard()  — remove near-duplicate stories (threshold 0.65)
 *   6. computeIDF() + noveltyBoost() — TF-IDF novelty signal from 4h corpus
 *   7. Re-score: total += novelty × NOVELTY_WEIGHT; re-sort; select TOP_POSTS
 *   8. Fetch top 5 replies for the 8 highest-scoring posts
 *   9. Write SQLite (posts + keywords tables)
 *  10. Upsert per-account stats (rolling averages → accounts table)
 *  11. clusterPosts() + detectBursts() → tagClusterBursts()
 *  12. formatClusteredDigest() → append to feed_digest.txt
 *  13. Append raw JSONL to feed_buffer.jsonl
 *  14. scrapeNotifications() → append new mentions to reply_queue.jsonl
 *
 * Writes:
 *   state/index.db           — SQLite FTS5 index (posts + keywords + accounts)
 *   state/feed_buffer.jsonl  — raw JSONL records (append)
 *   state/feed_digest.txt    — clustered scored+keyword digest (append)
 *   state/seen_ids.json      — dedup set (rolling 10k window)
 *   state/reply_queue.jsonl  — new mentions from notifications tab
 *
 * Usage:  node scraper/collect.js
 */

"use strict";

const { connectBrowser, getXPage } = require("../runner/cdp");
const fs        = require("fs");
const path      = require("path");
const db        = require("./db");
const analytics = require("./analytics");

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT        = path.resolve(__dirname, "..");
const ONTOLOGY    = path.join(ROOT, "state", "ontology.json");
const TRUST_GRAPH = path.join(ROOT, "state", "trust_graph.json");
const SEEN_IDS    = path.join(ROOT, "state", "seen_ids.json");
const FEED_BUFFER = path.join(ROOT, "state", "feed_buffer.jsonl");
const FEED_DIGEST = path.join(ROOT, "state", "feed_digest.txt");
const REPLY_QUEUE = path.join(ROOT, "state", "reply_queue.jsonl");

// ── Constants ─────────────────────────────────────────────────────────────────
const CDP_URL               = "http://127.0.0.1:18801";
const MAX_SEEN              = 10000;
const TOP_POSTS             = 25;
const TOP_REPLIES           = 5;
const REPLY_FETCH_COUNT     = 8;   // fetch replies for top N posts
const JACCARD_DEDUP_THRESHOLD    = 0.65;
const JACCARD_CLUSTER_THRESHOLD  = 0.25;
const NOVELTY_WEIGHT        = 0.4;
const CORPUS_WINDOW_HOURS   = 4;
const BURST_CURRENT_HOURS   = 4;
const BURST_PREV_HOURS      = 8;   // look at 4-8h ago as "previous window"

// ── State helpers ─────────────────────────────────────────────────────────────
function loadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return fallback; }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// extractKeywords is defined in analytics.js and re-exported here for use below
const { extractKeywords } = analytics;

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
    await new Promise(r => setTimeout(r, 1_500));
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

// ── Clustered digest formatting ───────────────────────────────────────────────

function fmtEngagement(likesStr, rtsStr) {
  const likes = parseCount(likesStr);
  const rts   = parseCount(rtsStr);
  const l = likes >= 1000 ? `${(likes/1000).toFixed(1)}k❤` : `${likes}❤`;
  const r = rts   >= 1000 ? `${(rts/1000).toFixed(1)}k🔁`  : `${rts}🔁`;
  return `[${l} ${r}]`;
}

function fmtPost(post) {
  const v  = post.velocity.toFixed(1);
  const n  = post.novelty.toFixed(1);
  const kw = post.keywords.length ? `  {${post.keywords.slice(0, 4).join(", ")}}` : "";
  const novel = (post.novelty >= 4.0 && !post._inCluster) ? "  <- novel" : "";
  const url = post.id ? `  https://x.com/${post.username}/status/${post.id}` : "";
  return (
    `  @${post.username} [v${v} T${post.trust} N${n}]` +
    ` "${post.text.replace(/\n+/g, " ").slice(0, 200)}"` +
    ` ${fmtEngagement(post.likes, post.rts)}${kw}${novel}${url}`
  );
}

function fmtReply(r) {
  const eng = parseCount(r.likes);
  const engStr = eng >= 1000 ? `${(eng/1000).toFixed(1)}k❤` : `${eng}❤`;
  return `  > @${r.username}: "${r.text.replace(/\n+/g, " ").slice(0, 150)}" [${engStr}]`;
}

/**
 * Format the clustered digest block for a single collect run.
 * @param {ScoredPost[]} selected - all TOP_POSTS selected posts
 * @param {Cluster[]} clusters - from analytics.clusterPosts()
 * @param {string} now - formatted timestamp
 * @returns {string}
 */
function formatClusteredDigest(selected, clusters, now) {
  const clusterCount   = clusters.length;
  const singletonCount = clusters.filter(c => c.posts.length === 1).length;
  const multiCount     = clusterCount - singletonCount;

  const lines = [
    ``,
    `── ${now} ── (${selected.length} posts, ${multiCount} clusters, ${singletonCount} singletons) ${"─".repeat(20)}`,
  ];

  // Legend (only on first block of the day — always include for AI readability)
  lines.push(
    `    v=velocity(HN) T=trust(0-10) N=novelty(TF-IDF,0-5)` +
    `  ★=burst  ←novel=rare-this-window`
  );
  lines.push("");

  // Multi-post clusters first
  let clusterIdx = 0;
  for (const cluster of clusters) {
    if (cluster.posts.length === 1) continue;
    clusterIdx++;
    const burst = cluster.isBurst ? "  ★ TRENDING" : "";
    lines.push(`CLUSTER ${clusterIdx} · "${cluster.label}" · ${cluster.posts.length} posts${burst}`);
    for (const post of cluster.posts) {
      post._inCluster = true;
      lines.push(fmtPost(post));
      for (const r of (post.topReplies || [])) lines.push(fmtReply(r));
    }
    lines.push("");
  }

  // Singletons section
  const singletons = clusters.filter(c => c.posts.length === 1).map(c => c.posts[0]);
  if (singletons.length > 0) {
    lines.push(`SINGLETONS · ${singletons.length} posts`);
    for (const post of singletons) {
      lines.push(fmtPost(post));
      for (const r of (post.topReplies || [])) lines.push(fmtReply(r));
    }
    lines.push("");
  }

  // Top novel posts — standalone signal for agent to notice genuinely rare frames
  const topNovel = [...selected]
    .filter(p => p.novelty >= 3.0)
    .sort((a, b) => b.novelty - a.novelty)
    .slice(0, 3);
  if (topNovel.length > 0) {
    lines.push(`NOVEL FRAMES · top ${topNovel.length} by TF-IDF rarity`);
    for (const post of topNovel) {
      lines.push(fmtPost(post));
    }
    lines.push("");
  }

  lines.push(`── end digest ${"─".repeat(60)}`);
  return lines.join("\n");
}

// ── Notifications / mentions scraper ─────────────────────────────────────────
async function scrapeNotifications(page) {
  console.log("[scraper] checking notifications/mentions...");

  const existingIds = new Set();
  try {
    const raw = fs.readFileSync(REPLY_QUEUE, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of raw) {
      try { existingIds.add(JSON.parse(line).id); } catch {}
    }
  } catch {}

  try {
    await page.goto("https://x.com/notifications", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await new Promise(r => setTimeout(r, 2_000));

    try {
      const tabs = await page.$$('[role="tab"]');
      for (const tab of tabs) {
        const label = await tab.evaluate(el => el.innerText).catch(() => "");
        if (/mentions/i.test(label)) { await tab.click(); await new Promise(r => setTimeout(r, 1_500)); break; }
      }
    } catch {}

    await page.evaluate(() => window.scrollBy(0, 800));
    await new Promise(r => setTimeout(r, 1_000));

    const mentions = await extractPosts(page);
    const newItems = [];

    for (const m of mentions) {
      if (!m.text || !m.id || existingIds.has(m.id)) continue;
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
    browser = await connectBrowser();
  } catch (err) {
    console.error(`[scraper] could not connect to Chrome: ${err.message}`);
    process.exit(1);
  }

  let page = await getXPage(browser);

  // Navigate to home feed
  try {
    if (!page.url().includes("x.com/home")) {
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
    await new Promise(r => setTimeout(r, 2_000));
  } catch (err) {
    console.error(`[scraper] failed to load feed: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  // Scroll to load more posts
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await new Promise(r => setTimeout(r, 1_200));
  }

  // ── Phase 1: Extract raw posts ────────────────────────────────────────────
  const raw = await extractPosts(page);
  console.log(`[scraper] extracted ${raw.length} raw posts`);

  // ── Phase 2: Sanitize ─────────────────────────────────────────────────────
  const sanitized = [];
  for (const post of raw) {
    if (!post.text || seenSet.has(post.id)) continue;
    const { keep } = analytics.sanitizePost(post);
    if (!keep) continue;
    sanitized.push(post);
  }
  console.log(`[scraper] ${sanitized.length} posts after sanitize+dedup`);

  // ── Phase 3: RAKE + base scoring ──────────────────────────────────────────
  const initialScored = [];
  for (const post of sanitized) {
    const engagement = parseCount(post.likes) + parseCount(post.rts) * 2 + parseCount(post.replies);
    const velocity   = gravityScore(engagement, post.ts);
    const trust      = trustScore(post.username, trustGraph);
    const alignment  = ontologyScore(post.text, ontology.axes);
    const keywords   = extractKeywords(post.text);
    initialScored.push({
      ...post,
      velocity, trust, alignment, keywords,
      total: velocity + trust * 0.5 + alignment * 0.3,
      novelty: 0,
    });
  }
  initialScored.sort((a, b) => b.total - a.total);

  // ── Phase 4: Jaccard near-duplicate dedup ─────────────────────────────────
  const deduped = analytics.deduplicateByJaccard(initialScored, JACCARD_DEDUP_THRESHOLD);
  console.log(`[scraper] ${deduped.length} posts after Jaccard dedup (${initialScored.length - deduped.length} near-dups removed)`);

  // ── Phase 5: TF-IDF novelty scoring ──────────────────────────────────────
  const corpusPosts = db.recentPosts(CORPUS_WINDOW_HOURS, 200);
  const idfMap = analytics.computeIDF(corpusPosts);
  const corpusN = corpusPosts.length;

  const scored = deduped.map(post => {
    const novelty = analytics.noveltyBoost(post, idfMap, corpusN);
    return { ...post, novelty, total: post.total + novelty * NOVELTY_WEIGHT };
  });
  scored.sort((a, b) => b.total - a.total);
  const selected = scored.slice(0, TOP_POSTS);
  console.log(`[scraper] selected ${selected.length} posts (top by velocity+trust+alignment+novelty)`);

  // ── Phase 6: Fetch top replies for highest-scoring posts ──────────────────
  const withReplies = [];
  for (const post of selected.slice(0, REPLY_FETCH_COUNT)) {
    const url = `https://x.com/${post.username}/status/${post.id}`;
    const replies = await fetchReplies(page, url, TOP_REPLIES);
    withReplies.push({ ...post, topReplies: replies });
    for (const r of replies) seenSet.add(r.id);
  }
  for (const post of selected.slice(REPLY_FETCH_COUNT)) {
    withReplies.push({ ...post, topReplies: [] });
  }

  // Mark feed posts as seen
  for (const post of withReplies) seenSet.add(post.id);
  const seenArr = Array.from(seenSet);
  const trimmed = seenArr.length > MAX_SEEN ? seenArr.slice(seenArr.length - MAX_SEEN) : seenArr;
  saveJson(SEEN_IDS, { ids: trimmed, updated_at: new Date().toISOString() });

  // ── Phase 7: Write SQLite index ───────────────────────────────────────────
  const scrapedAt = Date.now();
  for (const post of withReplies) {
    db.insertPost({
      id:           post.id,
      ts:           post.ts,
      ts_iso:       new Date(post.ts).toISOString(),
      username:     post.username,
      display_name: post.displayName,
      text:         post.text,
      likes:        parseCount(post.likes),
      rts:          parseCount(post.rts),
      replies:      parseCount(post.replies),
      velocity:     post.velocity,
      trust:        post.trust,
      score:        post.total,
      novelty:      post.novelty || 0,
      keywords:     post.keywords.join(", "),
      scraped_at:   scrapedAt,
    });
    for (const kw of post.keywords) {
      db.insertKeyword({ post_id: post.id, keyword: kw, score: post.total });
    }
    for (const r of post.topReplies) {
      const rkw = extractKeywords(r.text);
      db.insertPost({
        id:           r.id,
        ts:           r.ts,
        ts_iso:       new Date(r.ts).toISOString(),
        username:     r.username,
        display_name: r.displayName || r.username,
        text:         r.text,
        likes:        parseCount(r.likes),
        rts:          parseCount(r.rts),
        replies:      0,
        velocity:     gravityScore(parseCount(r.likes), r.ts),
        trust:        trustScore(r.username, trustGraph),
        score:        parseCount(r.likes) * 0.1,
        keywords:     rkw.join(", "),
        scraped_at:   scrapedAt,
        parent_id:    post.id,
      });
      for (const kw of rkw) {
        db.insertKeyword({ post_id: r.id, keyword: kw, score: parseCount(r.likes) * 0.1 });
      }
    }
  }

  // ── Phase 8: Upsert per-account stats ────────────────────────────────────
  const accountMap = new Map();
  for (const post of withReplies) {
    if (!accountMap.has(post.username)) accountMap.set(post.username, []);
    accountMap.get(post.username).push(post);
  }
  for (const [username, posts] of accountMap.entries()) {
    const existing   = db.getAccount(username);
    const prevCount  = existing?.post_count ?? 0;
    const newCount   = prevCount + posts.length;
    const newAvgScore    = ((existing?.avg_score    ?? 0) * prevCount + posts.reduce((s, p) => s + p.total, 0))    / newCount;
    const newAvgVelocity = ((existing?.avg_velocity ?? 0) * prevCount + posts.reduce((s, p) => s + p.velocity, 0)) / newCount;
    const kwFreq = {};
    for (const p of posts) for (const kw of p.keywords) kwFreq[kw] = (kwFreq[kw] || 0) + 1;
    const topKw = Object.entries(kwFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]).join(", ");
    db.upsertAccount({
      username,
      post_count:   newCount,
      avg_score:    newAvgScore,
      avg_velocity: newAvgVelocity,
      top_keywords: topKw,
      first_seen:   existing?.first_seen ?? scrapedAt,
      last_seen:    scrapedAt,
      follow_score: 0,
    });
  }

  // ── Phase 9: Cluster + burst detection ───────────────────────────────────
  const clusters = analytics.clusterPosts(withReplies, JACCARD_CLUSTER_THRESHOLD);
  const nowMs    = Date.now();
  const curWin   = db.postsInWindow(nowMs - BURST_CURRENT_HOURS * 3_600_000, nowMs);
  const prevWin  = db.postsInWindow(nowMs - BURST_PREV_HOURS * 3_600_000, nowMs - BURST_CURRENT_HOURS * 3_600_000);
  const burstSet = analytics.detectBursts(curWin, prevWin);
  analytics.tagClusterBursts(clusters, burstSet);

  const burstKwCount = burstSet.size;
  const clusterCount = clusters.filter(c => c.posts.length > 1).length;
  console.log(`[scraper] ${clusterCount} multi-post clusters, ${burstKwCount} bursting keyword(s)`);

  // ── Phase 10: Write clustered digest ──────────────────────────────────────
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const digestBlock = formatClusteredDigest(withReplies, clusters, now);
  fs.appendFileSync(FEED_DIGEST, digestBlock + "\n");

  // ── Phase 11: Write raw JSONL buffer ──────────────────────────────────────
  const bufferLines = withReplies.map(post => JSON.stringify({
    id: post.id, ts: post.ts, ts_iso: new Date(post.ts).toISOString(),
    u: post.username, dn: post.displayName, text: post.text,
    likes: parseCount(post.likes), rts: parseCount(post.rts),
    replies: parseCount(post.replies),
    velocity: parseFloat(post.velocity.toFixed(2)),
    novelty:  parseFloat(post.novelty.toFixed(2)),
    trust: post.trust, score: parseFloat(post.total.toFixed(2)),
    keywords: post.keywords,
    top_replies: post.topReplies.map(r => ({
      id: r.id, u: r.username, text: r.text,
      likes: parseCount(r.likes), rts: parseCount(r.rts),
    })),
  }));
  fs.appendFileSync(FEED_BUFFER, bufferLines.join("\n") + "\n");

  console.log(`[scraper] wrote ${withReplies.length} posts (${clusterCount} clusters) to index+digest+buffer`);

  // ── Phase 12: Scrape notifications / mentions ─────────────────────────────
  await scrapeNotifications(page);

  await browser.close();
  process.exit(0);
})();
