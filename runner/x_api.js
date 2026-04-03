#!/usr/bin/env node
/**
 * runner/x_api.js — X API v2 OAuth 1.0a helper
 *
 * Provides authenticated requests to the X (Twitter) API v2 using
 * OAuth 1.0a HMAC-SHA1 signatures. No external dependencies — uses
 * only Node.js built-in crypto and https modules.
 *
 * Environment variables (from .env):
 *   X_API_KEY            — Consumer Key (API Key)
 *   X_API_SECRET         — Consumer Secret (API Key Secret)
 *   X_ACCESS_TOKEN       — Access Token
 *   X_ACCESS_TOKEN_SECRET — Access Token Secret
 *
 * Usage:
 *   const { postTweet, postQuoteTweet } = require("./x_api");
 *   const result = await postTweet("Hello world");
 *   const quote  = await postQuoteTweet("My take:", "https://x.com/user/status/123");
 */

"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https  = require("https");

function loadEnvFileOnce() {
  const envPath = path.join(__dirname, "..", ".env");
  let loaded = false;

  try {
    require("dotenv").config({ path: envPath });
    loaded = true;
  } catch {}

  if (loaded || !fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFileOnce();

// ── Config ───────────────────────────────────────────────────────────────────

function getCredentials() {
  const apiKey       = process.env.X_API_KEY;
  const apiSecret    = process.env.X_API_SECRET;
  const accessToken  = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error(
      "Missing X API credentials. Set X_API_KEY, X_API_SECRET, " +
      "X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET in .env"
    );
  }

  return { apiKey, apiSecret, accessToken, accessSecret };
}

// ── OAuth 1.0a Signature ─────────────────────────────────────────────────────

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function generateNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeParamPairs(params) {
  const pairs = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([String(key), String(item)]);
    } else {
      pairs.push([String(key), String(value)]);
    }
  }
  pairs.sort((a, b) => {
    const ka = percentEncode(a[0]);
    const kb = percentEncode(b[0]);
    if (ka !== kb) return ka.localeCompare(kb);
    return percentEncode(a[1]).localeCompare(percentEncode(b[1]));
  });
  return pairs;
}

function generateSignature({ method, url, params, apiSecret, accessSecret }) {
  const sorted = normalizeParamPairs(params)
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sorted),
  ].join("&");

  const signingKey = `${percentEncode(apiSecret)}&${percentEncode(accessSecret)}`;

  return crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
}

function buildAuthHeader({ method, url, creds, query = {} }) {
  const { apiKey, apiSecret, accessToken, accessSecret } = creds;

  const oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  const signature = generateSignature({
    method,
    url,
    params: { ...oauthParams, ...query },
    apiSecret,
    accessSecret,
  });

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams).sort().map(k =>
    `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`
  ).join(", ");

  return `OAuth ${headerParts}`;
}

// ── HTTP Request ─────────────────────────────────────────────────────────────

function appendQuery(url, query) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) parsed.searchParams.append(key, String(item));
    } else {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function request({ method, url, headers, body, query }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(appendQuery(url, query));
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        if (!data.trim()) {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({});
          const err = new Error(`X API ${res.statusCode}: (empty response)`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error(`X API ${res.statusCode}: ${JSON.stringify(json)}`);
            err.statusCode = res.statusCode;
            err.response = json;
            reject(err);
          }
        } catch {
          const err = new Error(`X API ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("X API request timeout (30s)"));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

const API_BASE = "https://api.x.com/2";
const TWEETS_URL = `${API_BASE}/tweets`;
const DEFAULT_TWEET_FIELDS = [
  "attachments",
  "author_id",
  "conversation_id",
  "created_at",
  "entities",
  "lang",
  "public_metrics",
  "referenced_tweets",
  "text",
].join(",");
const DEFAULT_USER_FIELDS = [
  "created_at",
  "description",
  "location",
  "name",
  "pinned_tweet_id",
  "profile_image_url",
  "protected",
  "public_metrics",
  "url",
  "username",
  "verified",
].join(",");
const DEFAULT_EXPANSIONS = [
  "attachments.media_keys",
  "author_id",
  "referenced_tweets.id",
  "referenced_tweets.id.author_id",
].join(",");
const DEFAULT_MEDIA_FIELDS = [
  "media_key",
  "type",
  "url",
  "preview_image_url",
  "duration_ms",
  "public_metrics",
].join(",");

function withTimelineDefaults(params = {}, minMaxResults = 5) {
  const next = { ...params };
  if (next.max_results !== undefined) {
    const parsed = parseInt(next.max_results, 10);
    if (Number.isFinite(parsed)) {
      next.max_results = String(Math.max(minMaxResults, Math.min(100, parsed)));
    }
  }
  return {
    expansions: DEFAULT_EXPANSIONS,
    "tweet.fields": DEFAULT_TWEET_FIELDS,
    "user.fields": DEFAULT_USER_FIELDS,
    "media.fields": DEFAULT_MEDIA_FIELDS,
    ...next,
  };
}

async function xGet(url, query = {}) {
  const creds = getCredentials();
  const auth = buildAuthHeader({ method: "GET", url, creds, query });
  return request({
    method: "GET",
    url,
    query,
    headers: { Authorization: auth },
  });
}

async function xPost(url, body) {
  const creds = getCredentials();
  const auth = buildAuthHeader({ method: "POST", url, creds });
  return request({
    method: "POST",
    url,
    headers: { Authorization: auth },
    body,
  });
}

/**
 * Post a tweet.
 * @param {string} text - Tweet text (max 280 chars)
 * @returns {Promise<{id: string, text: string}>}
 */
async function postTweet(text) {
  const result = await xPost(TWEETS_URL, { text });

  return result.data;
}

/**
 * Post a quote tweet.
 * @param {string} text - Commentary text
 * @param {string} quoteTweetUrl - URL of the tweet to quote
 * @returns {Promise<{id: string, text: string}>}
 */
async function postQuoteTweet(text, quoteTweetUrl) {
  // Extract tweet ID from URL
  const match = quoteTweetUrl.match(/\/status\/(\d+)/);
  if (!match) throw new Error(`Invalid tweet URL: ${quoteTweetUrl}`);
  const quoteTweetId = match[1];

  const result = await xPost(TWEETS_URL, { text, quote_tweet_id: quoteTweetId });

  return result.data;
}

/**
 * Reply to a tweet.
 * @param {string} text - Reply text (max 280 chars)
 * @param {string} tweetId - ID of the tweet to reply to
 * @returns {Promise<{id: string, text: string}>}
 */
async function replyToTweet(text, tweetId) {
  const result = await xPost(TWEETS_URL, { text, reply: { in_reply_to_tweet_id: tweetId } });

  return result.data;
}

async function getUserByUsername(username, params = {}) {
  const safeUsername = String(username || "").replace(/^@/, "").trim();
  if (!safeUsername) throw new Error("username is required");
  return xGet(`${API_BASE}/users/by/username/${encodeURIComponent(safeUsername)}`, {
    "user.fields": DEFAULT_USER_FIELDS,
    ...params,
  });
}

async function getTweet(tweetId, params = {}) {
  if (!tweetId) throw new Error("tweetId is required");
  return xGet(`${API_BASE}/tweets/${encodeURIComponent(tweetId)}`, withTimelineDefaults(params));
}

async function getUserTweets(userId, params = {}) {
  if (!userId) throw new Error("userId is required");
  return xGet(`${API_BASE}/users/${encodeURIComponent(userId)}/tweets`, withTimelineDefaults(params));
}

async function getUserMentions(userId, params = {}) {
  if (!userId) throw new Error("userId is required");
  return xGet(`${API_BASE}/users/${encodeURIComponent(userId)}/mentions`, withTimelineDefaults(params));
}

async function getHomeTimeline(userId, params = {}) {
  if (!userId) throw new Error("userId is required");
  return xGet(`${API_BASE}/users/${encodeURIComponent(userId)}/timelines/reverse_chronological`, withTimelineDefaults(params));
}

async function searchRecent(query, params = {}) {
  if (!query || !String(query).trim()) throw new Error("search query is required");
  return xGet(`${API_BASE}/tweets/search/recent`, withTimelineDefaults({
    query: String(query).trim(),
    ...params,
  }, 10));
}

module.exports = {
  postTweet,
  postQuoteTweet,
  replyToTweet,
  getCredentials,
  getUserByUsername,
  getTweet,
  getUserTweets,
  getUserMentions,
  getHomeTimeline,
  searchRecent,
  DEFAULT_TWEET_FIELDS,
  DEFAULT_USER_FIELDS,
  DEFAULT_EXPANSIONS,
  DEFAULT_MEDIA_FIELDS,
};
