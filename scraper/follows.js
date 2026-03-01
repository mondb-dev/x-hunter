#!/usr/bin/env node
/**
 * scraper/follows.js — data-driven follow queue processor
 *
 * Uses per-account stats accumulated by collect.js (accounts table in SQLite)
 * to identify, score, and follow high-quality accounts that align with Sebastian's
 * ontology and post consistently interesting content.
 *
 * Pipeline:
 *   1. Load ontology + trust_graph + existing follow_queue
 *   2. Check daily cap (10 follows/day) — exit if reached
 *   3. Query accounts table: post_count >= 2, avg_score >= threshold
 *   4. computeFollowScore(): weighted combo of velocity, score, topic affinity, recency
 *   5. populateQueue(): add up to 5 new top candidates not already in queue
 *   6. Process pending items (up to 3/run): navigate x.com/username → Follow → log
 *   7. Persist queue + trust_graph
 *
 * Rate limits: max 3 follows/run, 10/day cap, 1 min between follows
 *
 * Usage: node scraper/follows.js
 * Env:   CDP browser on http://127.0.0.1:18801
 */

"use strict";

const { connectBrowser, getXPage } = require("../runner/cdp");
const fs   = require("fs");
const path = require("path");
const db   = require("./db");

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT          = path.resolve(__dirname, "..");
const FOLLOW_QUEUE  = path.join(ROOT, "state", "follow_queue.jsonl");
const TRUST_GRAPH   = path.join(ROOT, "state", "trust_graph.json");
const ONTOLOGY      = path.join(ROOT, "state", "ontology.json");

// ── Rate limits ───────────────────────────────────────────────────────────────
const MAX_PER_RUN         = 3;
const MAX_PER_DAY         = 10;
const MIN_GAP_MS          = 60 * 1000;       // 1 minute between follows
const CANDIDATE_MIN_POSTS = 2;
const CANDIDATE_MIN_SCORE = 5.0;             // avg_score threshold
const TOP_N_TO_QUEUE      = 5;              // max new candidates per run

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
    return fs.readFileSync(FOLLOW_QUEUE, "utf-8")
      .trim().split("\n").filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeQueue(items) {
  const content = items.map(i => JSON.stringify(i)).join("\n");
  fs.writeFileSync(FOLLOW_QUEUE, content + (items.length ? "\n" : ""));
}

// ── Daily cap check ───────────────────────────────────────────────────────────
function countTodayFollows(queue) {
  const today = new Date().toISOString().slice(0, 10);
  return queue.filter(i => i.status === "done" && i.followed_at?.startsWith(today)).length;
}

// ── Follow score computation ──────────────────────────────────────────────────

/**
 * Compute a follow candidate score from account stats + ontology.
 *
 * Weights:
 *   avg_velocity  × 0.35  — time-decayed engagement quality (HN gravity)
 *   avg_score     × 0.30  — composite score across all indexed posts
 *   topic_affinity × 0.25 — keyword overlap with ontology axis labels
 *   recency_factor × 0.10 — how recently this account was active
 *
 * topic_affinity: proportion of account's top_keywords that match an ontology
 *   axis label word (> 3 chars), scaled to [0..10].
 *
 * recency_factor: 10 × exp(-ageHours/48) — full credit if seen in last 48h,
 *   exponential decay after that.
 *
 * @param {{ avg_velocity, avg_score, top_keywords, last_seen }} account
 * @param {Array<{label: string}>} ontologyAxes
 * @returns {number}
 */
function computeFollowScore(account, ontologyAxes) {
  // topic_affinity
  const accountKws = (account.top_keywords || "").split(", ").filter(Boolean);
  const axisWords  = new Set(
    (ontologyAxes || []).flatMap(ax =>
      (ax.label || "").toLowerCase().split(/\W+/).filter(w => w.length > 3)
    )
  );
  const matches       = accountKws.filter(kw =>
    kw.split(" ").some(word => axisWords.has(word.toLowerCase()))
  ).length;
  const topicAffinity = Math.min(10, (matches / Math.max(accountKws.length, 1)) * 10);

  // recency_factor
  const ageHours      = Math.max(0, (Date.now() - (account.last_seen || 0)) / 3_600_000);
  const recencyFactor = 10 * Math.exp(-ageHours / 48);

  return (
    (account.avg_velocity || 0) * 0.35 +
    (account.avg_score    || 0) * 0.30 +
    topicAffinity               * 0.25 +
    recencyFactor               * 0.10
  );
}

// ── Queue population ──────────────────────────────────────────────────────────

/**
 * Add up to TOP_N_TO_QUEUE new candidates to the queue.
 * Skips any username already present in the queue (any status).
 *
 * @param {Object[]} queue - current queue items
 * @param {Object[]} candidates - scored candidates, sorted by follow_score DESC
 * @returns {{ added: number, queue: Object[] }}
 */
function populateQueue(queue, candidates) {
  const existingUsernames = new Set(queue.map(i => i.username));
  const toAdd = candidates
    .filter(c => !existingUsernames.has(c.username))
    .slice(0, TOP_N_TO_QUEUE);

  const now = new Date().toISOString();
  for (const c of toAdd) {
    queue.push({
      username:     c.username,
      follow_score: parseFloat(c.follow_score.toFixed(2)),
      top_keywords: c.top_keywords || "",
      avg_score:    parseFloat((c.avg_score || 0).toFixed(2)),
      post_count:   c.post_count || 0,
      queued_at:    now,
      status:       "pending",
      followed_at:  null,
      skip_reason:  null,
    });
  }

  return { added: toAdd.length, queue };
}

// ── CDP: follow a user ────────────────────────────────────────────────────────

/**
 * Navigate to a user's profile and click the Follow button.
 * Throws if the Follow button is not found (already followed, or private).
 *
 * @param {import('playwright').Page} page
 * @param {string} username
 */
async function followUser(page, username) {
  const profileUrl = `https://x.com/${username}`;
  console.log(`[follows] navigating to ${profileUrl}`);

  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 12_000 });
  await new Promise(r => setTimeout(r, 2_000));

  // X renders the follow button with aria-label="Follow @username"
  // Try multiple selectors for robustness
  let followBtn =
    await page.$(`[aria-label="Follow @${username}"]`) ||
    await page.$(`[data-testid="placementTracking"] [aria-label*="Follow"]`) ||
    await page.$(`[data-testid="userActions"] [aria-label*="Follow"]`);

  if (!followBtn) {
    // Check if we're already following them
    const alreadyFollowing = await page.$('[aria-label*="Following"]');
    if (alreadyFollowing) throw new Error(`already following @${username}`);
    throw new Error(`Follow button not found for @${username}`);
  }

  await followBtn.click();
  await new Promise(r => setTimeout(r, 2_000));
  console.log(`[follows] followed @${username}`);
}

// ── Trust graph update ────────────────────────────────────────────────────────

function logFollow(trustGraph, username, item) {
  if (!trustGraph.accounts) trustGraph.accounts = {};
  const key = username.toLowerCase();
  trustGraph.accounts[key] = {
    ...(trustGraph.accounts[key] || {}),
    followed:      true,
    followed_at:   new Date().toISOString(),
    follow_reason: `data-driven: avg_score=${item.avg_score?.toFixed(1)}, follow_score=${item.follow_score?.toFixed(1)}, topics=[${item.top_keywords}]`,
    cluster:       item.top_keywords?.split(", ")[0] || "unknown",
    weight:        1.0,
    trust_score:   3,  // neutral-positive start; AI adjusts during browse cycles
  };
  trustGraph.last_updated = new Date().toISOString();
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[follows] starting follow queue processor...");

  const ontology   = loadJson(ONTOLOGY, { axes: [] });
  const trustGraph = loadJson(TRUST_GRAPH, { accounts: {} });
  let queue = readQueue();

  // 1. Daily cap check
  const todayCount = countTodayFollows(queue);
  if (todayCount >= MAX_PER_DAY) {
    console.log(`[follows] daily cap reached (${todayCount}/${MAX_PER_DAY}). exiting.`);
    process.exit(0);
  }

  // 2. Query account candidates from SQLite
  const rawCandidates = db.followCandidates(CANDIDATE_MIN_POSTS, CANDIDATE_MIN_SCORE, 50);
  console.log(`[follows] ${rawCandidates.length} raw candidate(s) from accounts table`);

  // Filter accounts already in trust_graph as followed, compute follow_score
  const candidates = rawCandidates
    .filter(a => !trustGraph.accounts?.[a.username.toLowerCase()]?.followed)
    .map(a => ({ ...a, follow_score: computeFollowScore(a, ontology.axes) }))
    .sort((a, b) => b.follow_score - a.follow_score);

  // 3. Populate queue with new top candidates
  const { added } = populateQueue(queue, candidates);
  if (added > 0) {
    writeQueue(queue);
    queue = readQueue();
  }
  console.log(`[follows] added ${added} new candidate(s). pending: ${queue.filter(i => i.status === "pending").length}`);

  // 4. Get pending items sorted by follow_score DESC (best first)
  const pending = queue.filter(i => i.status === "pending")
    .sort((a, b) => b.follow_score - a.follow_score);

  if (pending.length === 0) {
    console.log("[follows] no pending follows. exiting.");
    process.exit(0);
  }

  // 5. Connect to browser via CDP
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`[follows] could not connect to CDP: ${err.message}`);
    process.exit(1);
  }

  let page;
  try {
    page = await getXPage(browser);
  } catch (err) {
    console.error(`[follows] could not get page: ${err.message}`);
    browser.disconnect();
    process.exit(1);
  }

  let followedThisRun = 0;

  // 6. Process pending follows
  for (const item of pending) {
    if (followedThisRun >= MAX_PER_RUN) break;
    if (countTodayFollows(queue) >= MAX_PER_DAY) break;

    console.log(`[follows] attempting @${item.username} (follow_score=${item.follow_score?.toFixed(1)}, topics=[${item.top_keywords}])`);

    try {
      await followUser(page, item.username);

      item.status      = "done";
      item.followed_at = new Date().toISOString();
      logFollow(trustGraph, item.username, item);
      db.markFollowed(item.username);
      followedThisRun++;

      // Wait between follows to avoid looking automated
      if (followedThisRun < MAX_PER_RUN && pending.indexOf(item) < pending.length - 1) {
        console.log(`[follows] waiting 1 min before next follow...`);
        await new Promise(r => setTimeout(r, MIN_GAP_MS));
      }
    } catch (err) {
      console.error(`[follows] failed @${item.username}: ${err.message}`);
      item.status      = "skipped";
      item.skip_reason = err.message;
    }
  }

  // 7. Persist
  writeQueue(queue);
  saveJson(TRUST_GRAPH, trustGraph);

  console.log(`[follows] done. followed ${followedThisRun} account(s) this run (today: ${countTodayFollows(queue)}/${MAX_PER_DAY}).`);
  browser.disconnect();
  process.exit(0);
})();
