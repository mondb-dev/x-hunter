#!/usr/bin/env node
/**
 * runner/comment_candidates.js — surface posts worth proactively commenting on
 *
 * Scores recent top posts against the local memory FTS5 index. Posts where
 * Hunter has a specific past observation to extend or contradict become
 * candidates for a proactive comment during the browse cycle.
 *
 * Also processes state/comment_done.txt (written by the agent after posting)
 * to update state/comment_log.json — the rate-limit ledger.
 *
 * Writes state/comment_candidates.txt for the browse cycle agent.
 *
 * Usage: node runner/comment_candidates.js
 * Rate limit: MAX_PER_DAY proactive comments, enforced here + in candidates file.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("../scraper/db");
const { extractKeywords } = require("../scraper/analytics");

const ROOT           = path.resolve(__dirname, "..");
const CANDIDATES_OUT = path.join(ROOT, "state", "comment_candidates.txt");
const COMMENT_LOG    = path.join(ROOT, "state", "comment_log.json");
const COMMENT_DONE   = path.join(ROOT, "state", "comment_done.txt");

const MAX_PER_DAY      = 3;
const SCORE_THRESHOLD  = 5;   // min post score — low bar, memory match is the real filter
const CANDIDATES_LIMIT = 3;   // max candidates shown to agent

// ── Comment log: load, init, save ─────────────────────────────────────────────

function loadLog() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const data = JSON.parse(fs.readFileSync(COMMENT_LOG, "utf-8"));
    if (data.today_date !== today) {
      data.today_date  = today;
      data.today_count = 0;
    }
    if (!data.commented_ids) data.commented_ids = [];
    if (!data.comments)      data.comments      = [];
    return data;
  } catch {
    return {
      today_date:      today,
      today_count:     0,
      max_per_day:     MAX_PER_DAY,
      last_comment_at: null,
      commented_ids:   [],
      comments:        [],
    };
  }
}

function saveLog(data) {
  fs.writeFileSync(COMMENT_LOG, JSON.stringify(data, null, 2));
}

// ── Process comment_done.txt if the agent wrote one ───────────────────────────
// Agent writes: {"id":"...","username":"...","url":"...","text":"...","commented_at":"..."}

function processCommentDone(log) {
  if (!fs.existsSync(COMMENT_DONE)) return;
  const raw = fs.readFileSync(COMMENT_DONE, "utf-8").trim();
  if (!raw) return;

  try {
    const done = JSON.parse(raw);
    if (done.id && !log.commented_ids.includes(done.id)) {
      log.commented_ids.push(done.id);
      // Keep commented_ids from growing unbounded (keep last 500)
      if (log.commented_ids.length > 500) log.commented_ids = log.commented_ids.slice(-500);
      log.today_count     = (log.today_count || 0) + 1;
      log.last_comment_at = done.commented_at || new Date().toISOString();
      log.comments.push(done);
      if (log.comments.length > 200) log.comments = log.comments.slice(-200);
      saveLog(log);
      console.log(`[comment] logged: @${done.username} — "${(done.text || "").slice(0, 60)}"`);
    }
  } catch (e) {
    console.warn(`[comment] could not parse comment_done.txt: ${e.message}`);
  }

  // Clear the signal file regardless of parse outcome
  fs.writeFileSync(COMMENT_DONE, "");
}

// ── Main ──────────────────────────────────────────────────────────────────────

const log = loadLog();
processCommentDone(log);

const now = new Date().toISOString().slice(0, 16).replace("T", " ");
const pad = (n) => "─".repeat(Math.max(0, n));

// Write a "cap reached" stub and exit early if already at daily limit
if (log.today_count >= MAX_PER_DAY) {
  const out = [
    `── comment candidates · ${now} ${pad(70 - now.length - 24)}`,
    `Daily cap reached (${log.today_count}/${MAX_PER_DAY}). No proactive comments today.`,
    `── end candidates ${pad(52)}`,
  ].join("\n");
  fs.writeFileSync(CANDIDATES_OUT, out);
  console.log(`[comment] cap reached (${log.today_count}/${MAX_PER_DAY}) — wrote empty candidates`);
  process.exit(0);
}

// Pull recent top posts (excludes replies via parent_id IS NULL in db.js)
const posts = db.recentPosts(4, 60);

const candidates = [];
for (const post of posts) {
  if (candidates.length >= CANDIDATES_LIMIT) break;
  if ((post.score || 0) < SCORE_THRESHOLD)        continue;
  if (log.commented_ids.includes(post.id))         continue;

  const keywords = extractKeywords(post.text, 5);
  if (!keywords.length) continue;

  const memMatches = db.recallMemory(keywords.join(" "), 1);
  if (!memMatches.length) continue;

  const tweetUrl = `https://x.com/${post.username}/status/${post.id}`;
  candidates.push({ post, tweetUrl, memory: memMatches[0] });
}

// Build the candidates file
const lines = [
  `── comment candidates · ${now} ${pad(70 - now.length - 24)}`,
  `Posts from last 4h where your memory has something specific to say.`,
  `(${log.today_count}/${MAX_PER_DAY} proactive comments used today)`,
  ``,
  `Pick AT MOST ONE to comment on — only if your memory gives you`,
  `something genuinely specific: a direct observation, contradiction,`,
  `or new angle. Skip entirely if nothing compels you.`,
  ``,
];

if (candidates.length === 0) {
  lines.push("  (no posts with memory matches above threshold — skip)");
  lines.push("");
} else {
  for (let i = 0; i < candidates.length; i++) {
    const { post, tweetUrl, memory } = candidates[i];
    const memExcerpt = (memory.text_content || "").replace(/\s+/g, " ").trim().slice(0, 180);
    lines.push(`  ${i + 1}. @${post.username} [score:${(post.score || 0).toFixed(0)}]`);
    lines.push(`     "${post.text.slice(0, 140)}"`);
    lines.push(`     URL: ${tweetUrl}`);
    lines.push(`     Your memory: [${memory.type} · ${memory.title} · ${memory.date}]`);
    lines.push(`     "${memExcerpt}..."`);
    lines.push(``);
  }
}

lines.push(`After commenting, write state/comment_done.txt (single JSON line):`);
lines.push(`{"id":"<post_id>","username":"<user>","url":"<tweet_url>","text":"<your comment>","commented_at":"<ISO>"}`);
lines.push(``);
lines.push(`── end candidates ${pad(52)}`);

fs.writeFileSync(CANDIDATES_OUT, lines.join("\n"));
console.log(`[comment] wrote ${candidates.length} candidate(s) to state/comment_candidates.txt`);
process.exit(0);
