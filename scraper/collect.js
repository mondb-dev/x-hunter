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

const dotenv = (() => {
  try { return require("dotenv"); } catch { return null; }
})();
const { connectBrowser } = require("../runner/cdp");
const fs        = require("fs");
const path      = require("path");
const db        = require("./db");
const analytics = require("./analytics");
const { describeMedia } = require("../runner/vision");
const { normalizedExternalUrls, domainsFromUrls, extractUrls } = require("../runner/lib/url_utils");
const {
  getUserByUsername,
  getHomeTimeline,
  getUserMentions,
  searchRecent,
} = require("../runner/x_api");

if (dotenv) dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT        = path.resolve(__dirname, "..");
const ONTOLOGY    = path.join(ROOT, "state", "ontology.json");
const TRUST_GRAPH = path.join(ROOT, "state", "trust_graph.json");
const SEEN_IDS    = path.join(ROOT, "state", "seen_ids.json");
const FEED_BUFFER = path.join(ROOT, "state", "feed_buffer.jsonl");
const FEED_DIGEST = path.join(ROOT, "state", "feed_digest.txt");
const REPLY_QUEUE = path.join(ROOT, "state", "reply_queue.jsonl");

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_SEEN              = 10000;
const TOP_REPLIES           = 5;

/**
 * Derive collection limits from cadence assessment signals.
 * signal_density + belief_velocity → how many posts to collect and reply-fetch.
 *
 * signal_density:  high=TRENDING+novel ≥8, medium=≥3, low=<3
 * belief_velocity: high=≥15 recent evidence, medium=≥5, low=<5
 *
 * Returns { topPosts, replyFetchCount }
 */
function getCollectionLimits() {
  try {
    const cadencePath = path.join(ROOT, "state", "cadence.json");
    const cad = JSON.parse(fs.readFileSync(cadencePath, "utf-8"));
    const density  = cad?.assessment?.signal_density  || "medium";
    const velocity = cad?.assessment?.belief_velocity || "medium";

    // High signal or high velocity → collect more
    const score = (density === "high" ? 2 : density === "medium" ? 1 : 0)
                + (velocity === "high" ? 1 : 0);

    if (score >= 3) return { topPosts: 50, replyFetchCount: 15 };
    if (score >= 2) return { topPosts: 40, replyFetchCount: 12 };
    if (score >= 1) return { topPosts: 25, replyFetchCount: 8  };
                    return { topPosts: 15, replyFetchCount: 5  };
  } catch {
    return { topPosts: 25, replyFetchCount: 8 };
  }
}
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

function isLoginRedirectUrl(url) {
  return /x\.com\/i\/flow\/login/.test(String(url || ""));
}

let cachedAuthedUser = null;

async function getAuthenticatedUser() {
  if (cachedAuthedUser) return cachedAuthedUser;
  const username = (process.env.X_USERNAME || "").trim();
  if (!username) throw new Error("X_USERNAME is not set");
  const result = await getUserByUsername(username);
  if (!result?.data?.id) throw new Error(`could not resolve X user for ${username}`);
  cachedAuthedUser = result.data;
  return cachedAuthedUser;
}

function buildIncludesMaps(response) {
  return {
    users: new Map((response?.includes?.users || []).map(u => [u.id, u])),
    media: new Map((response?.includes?.media || []).map(m => [m.media_key, m])),
  };
}

function inferApiMediaType(tweet, mediaMap) {
  const keys = tweet?.attachments?.media_keys || [];
  if (keys.some(k => /video|animated_gif/.test(mediaMap.get(k)?.type || ""))) return "video";
  if (keys.some(k => (mediaMap.get(k)?.type || "") === "photo")) return "image";
  return "none";
}

function extractApiExternalUrls(tweet) {
  const urls = [];
  for (const item of tweet?.entities?.urls || []) {
    const candidate = item.unwound_url || item.expanded_url || item.url;
    if (candidate) urls.push(candidate);
  }
  return normalizedExternalUrls(urls);
}

function mapApiTweet(tweet, maps) {
  const user = maps.users.get(tweet.author_id) || {};
  const metrics = tweet.public_metrics || {};
  const externalUrls = extractApiExternalUrls(tweet);
  return {
    id: tweet.id,
    username: user.username || "unknown",
    displayName: user.name || user.username || "unknown",
    text: tweet.text || "",
    ts: Date.parse(tweet.created_at || new Date().toISOString()),
    likes: String(metrics.like_count || 0),
    rts: String((metrics.retweet_count || 0) + (metrics.quote_count || 0)),
    replies: String(metrics.reply_count || 0),
    mediaType: inferApiMediaType(tweet, maps.media),
    external_urls: externalUrls.map(item => item.url),
    external_domains: domainsFromUrls(externalUrls),
  };
}

function mapApiTweets(response) {
  const maps = buildIncludesMaps(response);
  return (response?.data || []).map(tweet => mapApiTweet(tweet, maps));
}

async function fetchApiHomeTimelinePosts(count = 40) {
  const user = await getAuthenticatedUser();
  const response = await getHomeTimeline(user.id, { max_results: Math.min(100, count) });
  return mapApiTweets(response);
}

async function fetchApiReplies(post, topN) {
  const query = `conversation_id:${post.id} -from:${post.username}`;
  const response = await searchRecent(query, { max_results: 25 });
  return mapApiTweets(response)
    .filter(r => r.id !== post.id && r.text)
    .sort((a, b) =>
      (parseCount(b.likes) + parseCount(b.rts)) -
      (parseCount(a.likes) + parseCount(a.rts))
    )
    .slice(0, topN);
}

function loadQueuedReplyIds() {
  const existingIds = new Set();
  try {
    const raw = fs.readFileSync(REPLY_QUEUE, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of raw) {
      try { existingIds.add(JSON.parse(line).id); } catch {}
    }
  } catch {}
  try {
    const inter = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "interactions.json"), "utf-8"));
    for (const r of (inter.replies || [])) {
      if (r.id) existingIds.add(r.id);
    }
  } catch {}
  return existingIds;
}

function appendMentionsToReplyQueue(mentions) {
  const existingIds = loadQueuedReplyIds();
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
  if (newItems.length > 0) fs.appendFileSync(REPLY_QUEUE, newItems.join("\n") + "\n");
  return newItems.length;
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
        const externalUrls = [];
        for (const anchor of art.querySelectorAll('a[href]')) {
          const href = anchor.href || "";
          try {
            const parsed = new URL(href);
            const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
            if (host === "x.com" || host === "twitter.com") continue;
            if (!/^https?:$/.test(parsed.protocol)) continue;
            externalUrls.push(parsed.toString());
          } catch (_) {}
        }

        const timeEl  = art.querySelector("time");
        const ts      = timeEl ? new Date(timeEl.getAttribute("datetime")).getTime() : Date.now();

        const likes   = art.querySelector('[data-testid="like"]')?.innerText    || "0";
        const rts     = art.querySelector('[data-testid="retweet"]')?.innerText || "0";
        const replies = art.querySelector('[data-testid="reply"]')?.innerText   || "0";

        // ── Media detection ───────────────────────────────────────────────
        // Detect images: X uses <img> tags inside tweetPhoto containers
        const hasImages = !!art.querySelector('[data-testid="tweetPhoto"] img');
        // Detect video: X uses videoPlayer or videoComponent containers
        const hasVideo  = !!(art.querySelector('[data-testid="videoPlayer"]')
                           || art.querySelector('[data-testid="videoComponent"]')
                           || art.querySelector('video'));
        const mediaType = hasVideo ? "video" : hasImages ? "image" : "none";

        results.push({ id, username, displayName, text, ts, likes, rts, replies, mediaType, externalUrls });
      } catch (_) {}
    }
    return results;
  });
}

function enrichExternalUrls(post) {
  const textUrls = extractUrls(post.text || "");
  const external = normalizedExternalUrls([...(post.externalUrls || []), ...textUrls]);
  return {
    ...post,
    external_urls: external.map(item => item.url),
    external_domains: domainsFromUrls(external),
  };
}

/**
 * Capture a screenshot of the first media element (image or video thumbnail)
 * inside a tweet article, returned as a base64-encoded PNG.
 *
 * @param {import("puppeteer-core").Page} page
 * @param {string} postId - tweet status ID
 * @returns {Promise<{base64: string, mimeType: string}|null>}
 */
async function captureMediaScreenshot(page, postId) {
  try {
    // Find the specific article containing this post
    const elHandle = await page.evaluateHandle((id) => {
      const arts = document.querySelectorAll('article[data-testid="tweet"]');
      for (const art of arts) {
        const link = art.querySelector('a[href*="/status/"]');
        if (link && link.href.includes(`/status/${id}`)) {
          // Prefer image inside tweetPhoto, then video thumbnail, then videoPlayer
          return art.querySelector('[data-testid="tweetPhoto"] img')
              || art.querySelector('video')
              || art.querySelector('[data-testid="videoPlayer"]')
              || null;
        }
      }
      return null;
    }, postId);

    const el = elHandle.asElement();
    if (!el) {
      await elHandle.dispose();
      return null;
    }

    const b64 = await el.screenshot({ encoding: "base64", type: "png" });
    await elHandle.dispose();
    return b64 ? { base64: b64, mimeType: "image/png" } : null;
  } catch (err) {
    console.warn(`[scraper] media screenshot failed for ${postId}: ${err.message}`);
    return null;
  }
}

async function fetchReplies(page, tweetUrl, topN) {
  try {
    await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8_000 });
    await new Promise(r => setTimeout(r, 1_500));
    const all = await extractPosts(page);
    return all
      .slice(1)
      .filter(p => p.text.length > 0)
      .map(enrichExternalUrls)
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
  const media = post.mediaDescription ? `\n    📷 ${post.mediaDescription}` : "";
  return (
    `  @${post.username} [v${v} T${post.trust} N${n}]` +
    ` "${post.text.replace(/\n+/g, " ").slice(0, 200)}"` +
    ` ${fmtEngagement(post.likes, post.rts)}${kw}${novel}${url}${media}`
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
function formatClusteredDigest(selected, clusters, now, options = {}) {
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
    `  ★=burst  ←novel=rare-this-window  📷=media-description`
  );
  if (options.sourceNote) lines.push(`    SOURCE: ${options.sourceNote}`);
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

  try {
    await page.goto("https://x.com/notifications", { waitUntil: "domcontentloaded", timeout: 30_000 });
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
    const queued = appendMentionsToReplyQueue(mentions);
    console.log(`[scraper] notifications: queued ${queued} new mention(s)`);
  } catch (err) {
    console.error(`[scraper] notifications scrape failed: ${err.message}`);
  }
}

async function scrapeNotificationsApi() {
  console.log("[scraper] checking mentions via X API fallback...");
  try {
    const user = await getAuthenticatedUser();
    const response = await getUserMentions(user.id, { max_results: 20 });
    const mentions = mapApiTweets(response);
    const queued = appendMentionsToReplyQueue(mentions);
    console.log(`[scraper] mentions(api): queued ${queued} new mention(s)`);
  } catch (err) {
    console.error(`[scraper] mentions(api) failed: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[scraper] starting collect run...");

  const ontology   = loadJson(ONTOLOGY, { axes: [] });
  const trustGraph = loadJson(TRUST_GRAPH, { accounts: {} });
  const seenData   = loadJson(SEEN_IDS, { ids: [] });
  const seenSet    = new Set(seenData.ids);

  let browser = null;
  let page = null;
  let raw = [];
  let collectSourceNote = null;
  let browserReady = false;

  try {
    browser = await connectBrowser();
    page = await browser.newPage();
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise(r => setTimeout(r, 2_000));
    if (isLoginRedirectUrl(page.url())) {
      throw new Error(`x login redirect at ${page.url()}`);
    }
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12_000 });
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await new Promise(r => setTimeout(r, 1_200));
    }
    raw = await extractPosts(page);
    browserReady = true;
    console.log(`[scraper] extracted ${raw.length} raw posts`);
  } catch (err) {
    collectSourceNote = "X API fallback — reverse-chron timeline because browser auth is unavailable";
    console.warn(`[scraper] browser collect unavailable: ${err.message}`);
    try {
      raw = await fetchApiHomeTimelinePosts(60);
      console.log(`[scraper] extracted ${raw.length} posts via X API fallback`);
    } catch (apiErr) {
      console.error(`[scraper] API fallback failed: ${apiErr.message}`);
      if (page) await page.close().catch(() => {});
      if (browser) browser.disconnect();
      process.exit(1);
    }
  }

  // ── Phase 2: Sanitize ─────────────────────────────────────────────────────
  const sanitized = [];
  for (const post of raw) {
    if (!post.text || seenSet.has(post.id)) continue;
    const { keep } = analytics.sanitizePost(post);
    if (!keep) continue;
    sanitized.push(enrichExternalUrls(post));
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
  const { topPosts, replyFetchCount } = getCollectionLimits();
  const selected = scored.slice(0, topPosts);
  console.log(`[scraper] selected ${selected.length} posts (top by velocity+trust+alignment+novelty) [limit=${topPosts}]`);

  // ── Phase 5b: Capture media screenshots (before reply-fetch navigates away) ─
  const mediaPosts = selected.filter(p => p.mediaType && p.mediaType !== "none");
  const capturedMedia = [];  // {postId, base64, mimeType, context, mediaType}
  if (browserReady && mediaPosts.length > 0) {
    console.log(`[scraper] ${mediaPosts.length} posts with media — capturing screenshots...`);
    for (const post of mediaPosts.slice(0, 10)) {
      const shot = await captureMediaScreenshot(page, post.id);
      if (shot) {
        capturedMedia.push({
          postId:    post.id,
          base64:    shot.base64,
          mimeType:  shot.mimeType,
          context:   post.text,
          mediaType: post.mediaType,
        });
      }
    }
    console.log(`[scraper] captured ${capturedMedia.length}/${mediaPosts.slice(0, 10).length} media screenshots`);
  }

  // ── Phase 6: Fetch top replies for highest-scoring posts ──────────────────
  const withReplies = [];
  for (const post of selected.slice(0, replyFetchCount)) {
    let replies = [];
    try {
      replies = browserReady
        ? await fetchReplies(page, `https://x.com/${post.username}/status/${post.id}`, TOP_REPLIES)
        : await fetchApiReplies(post, TOP_REPLIES);
    } catch (err) {
      console.warn(`[scraper] reply fetch failed for ${post.id}: ${err.message}`);
    }
    withReplies.push({ ...post, topReplies: replies });
    for (const r of replies) seenSet.add(r.id);
  }
  for (const post of selected.slice(replyFetchCount)) {
    withReplies.push({ ...post, topReplies: [] });
  }

  // Mark feed posts as seen
  for (const post of withReplies) seenSet.add(post.id);
  const seenArr = Array.from(seenSet);
  const trimmed = seenArr.length > MAX_SEEN ? seenArr.slice(seenArr.length - MAX_SEEN) : seenArr;
  saveJson(SEEN_IDS, { ids: trimmed, updated_at: new Date().toISOString() });

  // ── Phase 6b: Vision — send captured screenshots to Gemini for description ─
  const mediaDescriptions = new Map();  // postId → description
  if (capturedMedia.length > 0) {
    console.log(`[scraper] sending ${capturedMedia.length} media items to Gemini vision...`);
    try {
      const descriptions = await describeMedia(capturedMedia);
      for (const [postId, desc] of descriptions) {
        mediaDescriptions.set(postId, desc);
      }
      console.log(`[scraper] vision described ${descriptions.size}/${capturedMedia.length} media items`);
    } catch (err) {
      console.warn(`[scraper] vision batch failed: ${err.message}`);
    }
  }
  // Attach descriptions to posts for digest formatting
  for (const post of withReplies) {
    post.mediaDescription = mediaDescriptions.get(post.id) || "";
  }

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
      external_urls: post.external_urls || [],
      external_domains: post.external_domains || [],
      media_type:        post.mediaType || "none",
      media_description: post.mediaDescription || "",
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
        external_urls: r.external_urls || [],
        external_domains: r.external_domains || [],
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
  const digestBlock = formatClusteredDigest(withReplies, clusters, now, {
    sourceNote: collectSourceNote,
  });
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
    media_type: post.mediaType || "none",
    media_description: post.mediaDescription || "",
    external_urls: post.external_urls || [],
    external_domains: post.external_domains || [],
    top_replies: post.topReplies.map(r => ({
      id: r.id, u: r.username, text: r.text,
      likes: parseCount(r.likes), rts: parseCount(r.rts),
      external_urls: r.external_urls || [],
      external_domains: r.external_domains || [],
    })),
  }));
  fs.appendFileSync(FEED_BUFFER, bufferLines.join("\n") + "\n");

  console.log(`[scraper] wrote ${withReplies.length} posts (${clusterCount} clusters) to index+digest+buffer`);

  // ── Phase 12: Scrape notifications / mentions ─────────────────────────────
  if (browserReady) {
    await scrapeNotifications(page);
  } else {
    await scrapeNotificationsApi();
  }

  // ── Write scrape throughput metrics (#6) ──────────────────────────────────
  const METRICS_PATH = path.join(ROOT, "state", "scrape_metrics.jsonl");
  const HEALTH_STATE_PATH = path.join(ROOT, "state", "health_state.json");
  const replyTotal = withReplies.reduce((n, post) => n + (post.topReplies?.length || 0), 0);
  fs.appendFileSync(METRICS_PATH, JSON.stringify({
    ts: scrapedAt,
    raw: raw.length,
    after_sanitize: sanitized.length,
    after_dedup: deduped.length,
    after_novelty: selected.length,
    stored: withReplies.length,
    api_fallback: collectSourceNote !== null,
    reply_count: replyTotal,
  }) + "\n");
  try {
    const _rawLines = fs.readFileSync(METRICS_PATH, "utf-8")
      .trim().split("\n").filter(Boolean).slice(-3)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (_rawLines.length >= 3 && _rawLines.every(m => m.stored < 5)) {
      let _health = {};
      try { _health = JSON.parse(fs.readFileSync(HEALTH_STATE_PATH, "utf-8")); } catch {}
      _health.scrape_degraded = true;
      _health.scrape_degraded_at = new Date().toISOString();
      fs.writeFileSync(HEALTH_STATE_PATH, JSON.stringify(_health, null, 2));
      console.warn("[scraper] SCRAPE DEGRADED: stored < 5 for 3 consecutive runs");
    }
  } catch {}

    if (page) await page.close().catch(() => {});
  if (browser) browser.disconnect();
  process.exit(0);
})();
