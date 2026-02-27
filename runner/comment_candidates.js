#!/usr/bin/env node
/**
 * runner/comment_candidates.js — surface posts worth proactively commenting on
 *
 * Scores recent top posts against the local memory FTS5 index. Posts where
 * Hunter has a specific past observation to extend or contradict become
 * candidates for a proactive comment during the browse cycle.
 *
 * Gate: proactive comments are only enabled once Hunter has developed solid
 * affinity to at least one belief axis — defined as:
 *   confidence >= MIN_AXIS_CONFIDENCE (0.40)  AND
 *   evidence_log.length >= MIN_EVIDENCE_COUNT (3)
 * on any axis in state/ontology.json.
 *
 * Also processes state/comment_done.txt (written by agent after posting)
 * to update state/comment_log.json — the rate-limit ledger.
 *
 * Writes state/comment_candidates.txt for the browse cycle agent.
 *
 * Usage: node runner/comment_candidates.js
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
const ONTOLOGY       = path.join(ROOT, "state", "ontology.json");

const MAX_PER_DAY         = 3;
const SCORE_THRESHOLD     = 5;    // min post score — low bar, memory match is the real filter
const CANDIDATES_LIMIT    = 3;    // max candidates shown to agent
const MIN_AXIS_CONFIDENCE = 0.40; // axis must be at least this confident
const MIN_EVIDENCE_COUNT  = 3;    // axis must have at least this many evidence entries

// ── Axis gate: check if Hunter has a settled belief to speak from ──────────────

function getStrongestAxis() {
  try {
    const data = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
    const axes = data.axes || [];
    if (!axes.length) return null;

    // Find axes that meet both thresholds, ranked by confidence then evidence count
    const qualified = axes
      .filter(a => (a.confidence || 0) >= MIN_AXIS_CONFIDENCE &&
                   (a.evidence_log || []).length >= MIN_EVIDENCE_COUNT)
      .sort((a, b) => {
        const confDiff = (b.confidence || 0) - (a.confidence || 0);
        if (Math.abs(confDiff) > 0.01) return confDiff;
        return (b.evidence_log || []).length - (a.evidence_log || []).length;
      });

    return qualified[0] || null;
  } catch {
    return null;
  }
}

// For the "not yet ready" message, show the most progressed axis so far
function getMostProgressedAxis() {
  try {
    const data = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
    const axes = data.axes || [];
    if (!axes.length) return null;
    return axes.sort((a, b) => {
      const confDiff = (b.confidence || 0) - (a.confidence || 0);
      if (Math.abs(confDiff) > 0.01) return confDiff;
      return (b.evidence_log || []).length - (a.evidence_log || []).length;
    })[0];
  } catch {
    return null;
  }
}

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

  fs.writeFileSync(COMMENT_DONE, "");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const pad = (n) => "─".repeat(Math.max(0, n));

function writeStub(lines) {
  fs.writeFileSync(CANDIDATES_OUT, lines.join("\n"));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const log = loadLog();
processCommentDone(log);

const now = new Date().toISOString().slice(0, 16).replace("T", " ");

// ── Gate check: does Hunter have a settled axis to speak from? ─────────────────
const strongAxis = getStrongestAxis();

if (!strongAxis) {
  const best = getMostProgressedAxis();
  const bestDesc = best
    ? `"${best.label}" — confidence: ${((best.confidence || 0) * 100).toFixed(0)}%, ` +
      `${(best.evidence_log || []).length} evidence entries`
    : "no axes yet";

  writeStub([
    `── comment candidates · ${now} ${pad(70 - now.length - 24)}`,
    `Not ready for proactive comments yet.`,
    ``,
    `Threshold: confidence ≥ ${(MIN_AXIS_CONFIDENCE * 100).toFixed(0)}% with ≥ ${MIN_EVIDENCE_COUNT} evidence entries on any axis.`,
    `Most progressed: ${bestDesc}`,
    `── end candidates ${pad(52)}`,
  ]);
  console.log(`[comment] axis gate not met — most progressed: ${bestDesc}`);
  process.exit(0);
}

// ── Daily cap ─────────────────────────────────────────────────────────────────
if (log.today_count >= MAX_PER_DAY) {
  writeStub([
    `── comment candidates · ${now} ${pad(70 - now.length - 24)}`,
    `Daily cap reached (${log.today_count}/${MAX_PER_DAY}). No proactive comments today.`,
    `── end candidates ${pad(52)}`,
  ]);
  console.log(`[comment] cap reached (${log.today_count}/${MAX_PER_DAY})`);
  process.exit(0);
}

// ── Find candidates ───────────────────────────────────────────────────────────
const posts = db.recentPosts(4, 60);

const candidates = [];
for (const post of posts) {
  if (candidates.length >= CANDIDATES_LIMIT) break;
  if ((post.score || 0) < SCORE_THRESHOLD)   continue;
  if (log.commented_ids.includes(post.id))    continue;

  const keywords = extractKeywords(post.text, 5);
  if (!keywords.length) continue;

  const memMatches = db.recallMemory(keywords.join(" "), 1);
  if (!memMatches.length) continue;

  const tweetUrl = `https://x.com/${post.username}/status/${post.id}`;
  candidates.push({ post, tweetUrl, memory: memMatches[0] });
}

// ── Build candidates file ─────────────────────────────────────────────────────
const evidenceCount = (strongAxis.evidence_log || []).length;
const lines = [
  `── comment candidates · ${now} ${pad(70 - now.length - 24)}`,
  `Active axis: "${strongAxis.label}"`,
  `  confidence: ${((strongAxis.confidence || 0) * 100).toFixed(0)}%  ·  ${evidenceCount} evidence entries`,
  `  "${strongAxis.left_pole}" ↔ "${strongAxis.right_pole}"`,
  ``,
  `(${log.today_count}/${MAX_PER_DAY} proactive comments used today)`,
  ``,
  `Posts where your memory has something specific to say.`,
  `Pick AT MOST ONE — only if your memory gives you something genuinely specific:`,
  `a direct observation, contradiction, or angle not yet in the thread.`,
  `Skip entirely if nothing compels you.`,
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

writeStub(lines);
console.log(`[comment] axis "${strongAxis.label}" (${((strongAxis.confidence||0)*100).toFixed(0)}% confidence, ${evidenceCount} entries) — wrote ${candidates.length} candidate(s)`);
process.exit(0);
