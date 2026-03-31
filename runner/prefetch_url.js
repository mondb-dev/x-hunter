#!/usr/bin/env node
/**
 * runner/prefetch_url.js — pre-navigate browser to curiosity search URL before browse cycle
 *
 * Reads the ACTIVE SEARCH URL from state/curiosity_directive.txt and navigates
 * the CDP-connected Chrome to that URL. By the time the browse agent starts,
 * the page is already loaded and the agent can read it without spending navigation
 * tool calls.
 *
 * If no URL is found in the directive, navigates to x.com/home (neutral reset).
 *
 * Exit 0 always (non-fatal — browser failure should not block browse cycle).
 *
 * Usage: node runner/prefetch_url.js
 * Called by run.sh at the start of each browse cycle, before agent_run.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser, getXPage } = require("./cdp");
const {
  getUserByUsername,
  getUserTweets,
  getHomeTimeline,
  getTweet,
  searchRecent,
} = require("./x_api");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const ROOT         = path.resolve(__dirname, "..");
const DIRECTIVE    = path.join(ROOT, "state", "curiosity_directive.txt");
const READING_URL  = path.join(ROOT, "state", "reading_url.txt");
const API_CONTEXT  = path.join(ROOT, "state", "api_prefetch_context.txt");
const HOME_URL     = "https://x.com/home";
const TIMEOUT      = 20_000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clearApiContext() { fs.writeFileSync(API_CONTEXT, "", "utf-8"); }
function writeApiContext(text) { fs.writeFileSync(API_CONTEXT, text.trim() + "\n", "utf-8"); }
function isLoginRedirectUrl(url) { return /x\.com\/i\/flow\/login/.test(String(url || "")); }

/** Extract all SEARCH_URL_N: lines from curiosity directive; rotate by cycle. */
function extractSearchUrl(text, cycle) {
  if (!text) return null;
  // New multi-angle format: SEARCH_URL_1:, SEARCH_URL_2:, SEARCH_URL_3:
  const angles = [];
  const re = /SEARCH_URL_\d+:\s*(https?:\/\/\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) angles.push(m[1].trim());
  if (angles.length > 0) {
    const idx = (cycle || 0) % angles.length;
    return angles[idx];
  }
  // Legacy fallback: single Navigate: line
  const legacy = text.match(/Navigate:\s*(https?:\/\/\S+)/);
  return legacy ? legacy[1].trim() : null;
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
  };
}

function mapApiTweet(tweet, userMap) {
  const user = userMap.get(tweet.author_id) || {};
  const metrics = tweet.public_metrics || {};
  return {
    id: tweet.id,
    username: user.username || "unknown",
    displayName: user.name || user.username || "unknown",
    text: (tweet.text || "").replace(/\s+/g, " ").trim(),
    createdAt: tweet.created_at || "",
    likes: metrics.like_count || 0,
    rts: (metrics.retweet_count || 0) + (metrics.quote_count || 0),
    replies: metrics.reply_count || 0,
  };
}

function formatTweetLines(posts, prefix = "-") {
  if (!posts.length) return `${prefix} (none returned)`;
  return posts.map(post =>
    `${prefix} @${post.username}: "${post.text.slice(0, 220)}"` +
    ` [${post.likes} likes, ${post.rts} boosts, ${post.replies} replies]` +
    (post.createdAt ? ` ${post.createdAt}` : "") +
    (post.id && post.username !== "unknown" ? ` https://x.com/${post.username}/status/${post.id}` : "")
  ).join("\n");
}

function buildFallbackHeader(reason, targetType, targetUrl) {
  return [
    `API fallback active: ${reason}`,
    `Target type: ${targetType}`,
    `Target URL: ${targetUrl}`,
    `Note: this is X API data, not rendered UI. Home timeline is reverse-chron, not 'For You'.`,
    "",
  ].join("\n");
}

function classifyTarget(url) {
  const parsed = new URL(url);
  const hostOk = /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(parsed.hostname);
  if (!hostOk) return { kind: "unsupported" };

  const cleanPath = parsed.pathname.replace(/\/+$/, "") || "/";
  const parts = cleanPath.split("/").filter(Boolean);
  if (cleanPath === "/home") return { kind: "home" };
  if (parts[0] === "search") {
    return { kind: "search", query: parsed.searchParams.get("q") || "" };
  }
  if (parts.length === 1 && /^[A-Za-z0-9_]+$/.test(parts[0])) {
    return { kind: "profile", username: parts[0] };
  }
  if (parts.length >= 3 && /^[A-Za-z0-9_]+$/.test(parts[0]) && parts[1] === "status") {
    return { kind: "tweet", username: parts[0], tweetId: parts[2] };
  }
  return { kind: "unsupported" };
}

async function buildProfileContext(username, header) {
  const userResp = await getUserByUsername(username);
  const user = userResp?.data;
  if (!user?.id) throw new Error(`profile lookup failed for @${username}`);
  const tweetsResp = await getUserTweets(user.id, { max_results: 10 });
  const users = buildIncludesMaps(tweetsResp).users;
  const posts = (tweetsResp?.data || []).map(t => mapApiTweet(t, users));
  const metrics = user.public_metrics || {};
  return header +
    `PROFILE SNAPSHOT\n` +
    `@${user.username} (${user.name || user.username})\n` +
    `Bio: ${(user.description || "(no bio)").replace(/\s+/g, " ").trim()}\n` +
    `Followers: ${metrics.followers_count ?? "?"} | Following: ${metrics.following_count ?? "?"} | Tweets: ${metrics.tweet_count ?? "?"}\n` +
    `Pinned tweet id: ${user.pinned_tweet_id || "(none)"}\n\n` +
    `Recent posts:\n${formatTweetLines(posts)}\n`;
}

async function buildTweetContext(tweetId, header) {
  const tweetResp = await getTweet(tweetId);
  const users = buildIncludesMaps(tweetResp).users;
  const tweet = tweetResp?.data ? mapApiTweet(tweetResp.data, users) : null;
  if (!tweet) throw new Error(`tweet lookup failed for ${tweetId}`);
  const repliesResp = await searchRecent(`conversation_id:${tweetId} -from:${tweet.username}`, { max_results: 10 });
  const replyUsers = buildIncludesMaps(repliesResp).users;
  const replies = (repliesResp?.data || []).map(t => mapApiTweet(t, replyUsers)).slice(0, 6);
  return header +
    `TWEET SNAPSHOT\n` +
    `${formatTweetLines([tweet], "-")}\n\n` +
    `Recent replies in the conversation:\n${formatTweetLines(replies)}\n`;
}

async function buildSearchContext(query, header) {
  const trimmed = String(query || "").trim();
  if (!trimmed) throw new Error("search URL has no q= parameter");
  const searchResp = await searchRecent(trimmed, { max_results: 10 });
  const users = buildIncludesMaps(searchResp).users;
  const posts = (searchResp?.data || []).map(t => mapApiTweet(t, users));
  return header +
    `SEARCH SNAPSHOT\n` +
    `Query: ${trimmed}\n\n` +
    `Recent matching posts:\n${formatTweetLines(posts)}\n`;
}

async function buildHomeContext(header) {
  const user = await getAuthenticatedUser();
  const timelineResp = await getHomeTimeline(user.id, { max_results: 10 });
  const users = buildIncludesMaps(timelineResp).users;
  const posts = (timelineResp?.data || []).map(t => mapApiTweet(t, users));
  return header +
    `HOME TIMELINE SNAPSHOT\n` +
    `Reverse chronological home timeline for @${user.username}.\n\n` +
    `Recent posts:\n${formatTweetLines(posts)}\n`;
}

async function writeApiFallbackContext({ reason, targetType, targetUrl }) {
  const target = classifyTarget(targetUrl);
  const header = buildFallbackHeader(reason, targetType, targetUrl);
  let body;
  if (target.kind === "profile") {
    body = await buildProfileContext(target.username, header);
  } else if (target.kind === "tweet") {
    body = await buildTweetContext(target.tweetId, header);
  } else if (target.kind === "search") {
    body = await buildSearchContext(target.query, header);
  } else if (target.kind === "home") {
    body = await buildHomeContext(header);
  } else {
    body = header + "No API fallback is available for this URL shape.\n";
  }
  writeApiContext(body);
}

(async () => {
  clearApiContext();

  // Read target URL — deep dive takes priority over curiosity
  let targetUrl = HOME_URL;
  let targetType = "home";
  try {
    // 1. Deep dive (reading queue) takes priority
    if (fs.existsSync(READING_URL)) {
      const rtext = fs.readFileSync(READING_URL, "utf-8").trim();
      const rm = rtext.match(/^URL:\s*(.+)$/m);
      if (rm && rm[1].trim()) {
        targetUrl = rm[1].trim();
        targetType = "deep_dive";
        console.log(`[prefetch] deep dive URL: ${targetUrl}`);
      }
    }
    // 2. Curiosity search if no deep dive active
    if (targetType === "home" && fs.existsSync(DIRECTIVE)) {
      const text = fs.readFileSync(DIRECTIVE, "utf-8");
      const cycle = parseInt(process.env.PREFETCH_CYCLE || "0", 10);
      const searchUrl = extractSearchUrl(text, cycle);
      if (searchUrl) {
        targetUrl = searchUrl;
        targetType = "curiosity";
        console.log(`[prefetch] curiosity URL: ${targetUrl}`);
      } else {
        console.log("[prefetch] no ACTIVE SEARCH URL in directive — navigating to home");
      }
    }
    if (targetType === "home") {
      console.log("[prefetch] no curiosity directive — navigating to home");
    }
  } catch (e) {
    console.log(`[prefetch] could not read directive: ${e.message} — navigating to home`);
  }

  // Connect to Chrome (connectBrowser does the pre-flight /json/version fetch internally)
  let browser;
  try {
    browser = await connectBrowser(5_000);
  } catch (err) {
    console.log(`[prefetch] Chrome not available (${err.message}) — using API fallback context`);
    try {
      await writeApiFallbackContext({
        reason: `Chrome unavailable (${err.message})`,
        targetType,
        targetUrl,
      });
    } catch (apiErr) {
      console.log(`[prefetch] API fallback failed: ${apiErr.message}`);
    }
    process.exit(0);
  }

  try {
    const page = await getXPage(browser);

    console.log(`[prefetch] navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await sleep(2_500); // let dynamic content load

    if (isLoginRedirectUrl(page.url())) {
      console.log(`[prefetch] browser landed on login (${page.url()}) — writing API fallback context`);
      try {
        await writeApiFallbackContext({
          reason: `browser landed on login redirect (${page.url()})`,
          targetType,
          targetUrl,
        });
      } catch (apiErr) {
        console.log(`[prefetch] API fallback failed: ${apiErr.message}`);
      }
    } else {
      console.log(`[prefetch] done — page ready at ${page.url()}`);
    }
  } catch (err) {
    console.log(`[prefetch] navigation error: ${err.message} — writing API fallback context`);
    try {
      await writeApiFallbackContext({
        reason: `navigation error (${err.message})`,
        targetType,
        targetUrl,
      });
    } catch (apiErr) {
      console.log(`[prefetch] API fallback failed: ${apiErr.message}`);
    }
  } finally {
    browser.disconnect();
  }

  process.exit(0);
})();
