#!/usr/bin/env node
/**
 * runner/posts_log.js — shared helper for writing to state/posts_log.json
 *
 * Called by post_tweet.js and post_quote.js immediately after a successful post.
 * Single source of truth — run.sh inline patchers removed.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT     = path.resolve(__dirname, "..");
const LOG_FILE = path.join(ROOT, "state", "posts_log.json");

function readLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return { total_posts: 0, posts: [] };
    const raw = fs.readFileSync(LOG_FILE, "utf-8").trim();
    if (!raw) return { total_posts: 0, posts: [] };
    const data = JSON.parse(raw);
    // Normalise: accept both array and { posts: [] } formats
    const posts = Array.isArray(data) ? data : (data.posts ?? []);
    return { total_posts: posts.length, posts };
  } catch {
    return { total_posts: 0, posts: [] };
  }
}

function writeLog(log) {
  log.total_posts = log.posts.length;
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

/**
 * Append a tweet entry. Skips if a tweet entry with the same content already exists.
 */
function logTweet({ content, tweet_url, date, cycle }) {
  const log = readLog();
  // Avoid duplicate: same content already logged (agent may write with type "observation"/"question")
  const dup = log.posts.find(p => p.content === content);
  if (dup) {
    // Patch URL if it was missing
    if (!dup.tweet_url && tweet_url) {
      dup.tweet_url = tweet_url;
      writeLog(log);
      console.log("[posts_log] patched existing entry with URL");
    }
    // Normalize type to "tweet" if runner is calling logTweet
    if (dup.type !== "tweet") {
      dup.type = "tweet";
      writeLog(log);
      console.log("[posts_log] normalized entry type to tweet");
    }
    return;
  }
  log.posts.push({
    type: "tweet",
    content,
    tweet_url: tweet_url || "",
    date: date || new Date().toISOString().slice(0, 10),
    cycle: cycle || null,
    posted_at: new Date().toISOString(),
  });
  writeLog(log);
  console.log(`[posts_log] logged tweet (${content.length} chars)`);
}

/**
 * Append a quote entry. Upserts if agent already wrote an entry with same source_url.
 */
function logQuote({ source_url, content, tweet_url, date, cycle }) {
  const log = readLog();
  // Upsert: if a quote entry with same source_url exists without a tweet_url, patch it
  const existing = source_url ? log.posts.find(p =>
    p.type === "quote" &&
    p.source_url === source_url &&
    !p.tweet_url
  ) : null;
  if (existing) {
    existing.type = "quote";
    existing.tweet_url = tweet_url || "";
    existing.content = content || existing.content || existing.text || "";
    existing.posted_at = new Date().toISOString();
    writeLog(log);
    console.log("[posts_log] updated existing quote entry");
    return;
  }
  log.posts.push({
    type: "quote",
    source_url,
    content,
    tweet_url: tweet_url || "",
    date: date || new Date().toISOString().slice(0, 10),
    cycle: cycle || null,
    posted_at: new Date().toISOString(),
  });
  writeLog(log);
  console.log(`[posts_log] logged quote (source: ${source_url})`);
}

module.exports = { logTweet, logQuote };
