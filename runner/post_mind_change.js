#!/usr/bin/env node
/**
 * runner/post_mind_change.js — detect and post explicit mind-change tweets
 *
 * Detects axes where Sebastian's belief has shifted substantially since
 * the last time he acknowledged changing his mind publicly. Posts a frank
 * "I've changed my mind about X" tweet.
 *
 * Gate: max 1 mind-change post per week. Also throttled to once per 4h via
 * stamp file (checked by post_browse.js before calling).
 *
 * Detection: axis where |current_score - committed_score| >= 0.20
 *   AND confidence >= 0.65 AND >= 10 new evidence entries since last post.
 *
 * State: state/mind_change_state.json (committed scores + weekly gate)
 *
 * Usage:
 *   node runner/post_mind_change.js
 *   node runner/post_mind_change.js --dry-run
 */

"use strict";

const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");

const ROOT             = path.resolve(__dirname, "..");
const ONTO_PATH        = path.join(ROOT, "state", "ontology.json");
const MIND_STATE_PATH  = path.join(ROOT, "state", "mind_change_state.json");
const DRAFT_PATH       = path.join(ROOT, "state", "tweet_draft.txt");
const VOCATION_PATH    = path.join(ROOT, "state", "vocation.json");

const { callVertex } = require("./vertex.js");

const SCORE_DELTA_THRESHOLD   = 0.20;
const CONFIDENCE_MIN           = 0.65;
const MIN_NEW_EVIDENCE         = 10;
const WEEKLY_MAX               = 1;
const isDryRun                 = process.argv.includes("--dry-run");

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

/** Returns ISO week string like "2026-W19" */
function isoWeek(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function defaultState() {
  return {
    last_posted_at: null,
    weekly_count: 0,
    week_start: isoWeek(new Date()),
    axes: {},
  };
}

function loadState() {
  return loadJson(MIND_STATE_PATH) || defaultState();
}

function getCurrentWeek() {
  return isoWeek(new Date());
}

/** Find the axis with the largest verified score shift. */
function findBestCandidate(onto, state) {
  const thisWeek = getCurrentWeek();
  // Reset weekly counter if week rolled over
  if (state.week_start !== thisWeek) {
    state.weekly_count = 0;
    state.week_start = thisWeek;
  }

  if (state.weekly_count >= WEEKLY_MAX) {
    return null; // already posted this week
  }

  let best = null;
  let bestDelta = 0;

  for (const axis of (onto.axes || [])) {
    const current = axis.score ?? 0;
    const confidence = axis.confidence ?? 0;
    if (confidence < CONFIDENCE_MIN) continue;

    const committed = state.axes[axis.id];
    if (!committed) continue; // not yet initialized — will be seeded below

    const delta = Math.abs(current - committed.committed_score);
    if (delta < SCORE_DELTA_THRESHOLD) continue;

    const totalEvidence = (axis.evidence_log || []).length;
    const newEvidence = totalEvidence - (committed.evidence_count_at_post || 0);
    if (newEvidence < MIN_NEW_EVIDENCE) continue;

    if (delta > bestDelta) {
      bestDelta = delta;
      best = { axis, committed, delta, totalEvidence };
    }
  }

  return best;
}

/** Seed or refresh committed states for axes we haven't seen before. */
function seedNewAxes(onto, state) {
  let seeded = false;
  for (const axis of (onto.axes || [])) {
    if (!state.axes[axis.id]) {
      state.axes[axis.id] = {
        committed_score: axis.score ?? 0,
        committed_at: new Date().toISOString(),
        evidence_count_at_post: (axis.evidence_log || []).length,
      };
      seeded = true;
    }
  }
  return seeded;
}

async function generateMindChangeTweet(axis, committed, delta, vocation) {
  const direction = axis.score > committed.committed_score ? "right" : "left";
  const fromPole = direction === "right" ? axis.pole_left : axis.pole_right;
  const toPole   = direction === "right" ? axis.pole_right : axis.pole_left;
  const fromScore = Math.round(committed.committed_score * 100);
  const toScore   = Math.round(axis.score * 100);

  const recentEvidence = (axis.evidence_log || [])
    .slice(-5)
    .map(e => e.content || "")
    .filter(Boolean)
    .join(" | ")
    .slice(0, 600);

  const vocLabel = vocation?.label || "Digital Watchdog for Public Integrity";

  const prompt = `You are Sebastian D. Hunter, an autonomous AI agent whose vocation is "${vocLabel}".
You track your own beliefs rigorously and acknowledge when evidence changes your mind.

Belief axis: "${axis.label}"
  Spectrum: "${fromPole}" ←→ "${toPole}"
  Before: ${fromScore}% toward "${toPole}" (committed on ${committed.committed_at?.slice(0, 10)})
  Now:    ${toScore}% toward "${toPole}"
  Change: ${Math.round(delta * 100)}pp shift based on ${axis.evidence_log?.length || 0} evidence entries

Recent evidence driving this shift:
${recentEvidence || "(not available)"}

Write a tweet acknowledging this mind change. Be direct and intellectually honest.

RULES:
- Start with something like "I've updated my view on..." or "I was wrong about..." or "New evidence changed my mind:"
- Name the specific topic or claim, not axis labels or internal system terms
- Briefly say what changed and why (cite one concrete piece of evidence if available)
- Keep it under 260 characters
- First person, no hashtags, no emojis, no hedging
- This should read as genuine intellectual honesty, not performative humility

Return ONLY the tweet text.`;

  const raw = await callVertex(prompt, 400);
  return raw.trim().replace(/^["']|["']$/g, "");
}

function postTweet(text) {
  fs.writeFileSync(DRAFT_PATH, text + "\n", "utf-8");
  try {
    execSync(`node "${path.join(ROOT, "runner/post_tweet.js")}"`, { cwd: ROOT, stdio: "ignore", timeout: 60_000 });
    return true;
  } catch {
    try {
      execSync(`node "${path.join(ROOT, "runner/post_tweet_api.js")}"`, { cwd: ROOT, stdio: "ignore", timeout: 60_000 });
      return true;
    } catch (e) {
      console.error(`[post_mind_change] tweet failed: ${e.message}`);
      return false;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async function main() {
  const onto = loadJson(ONTO_PATH);
  if (!onto) {
    process.exit(0);
  }

  const state = loadState();
  const vocation = loadJson(VOCATION_PATH);

  // Seed any new axes (idempotent)
  const seeded = seedNewAxes(onto, state);
  if (seeded && !isDryRun) {
    saveJson(MIND_STATE_PATH, state);
  }

  const candidate = findBestCandidate(onto, state);
  if (!candidate) {
    if (seeded && !isDryRun) saveJson(MIND_STATE_PATH, state);
    process.exit(0);
  }

  const { axis, committed, delta } = candidate;

  console.log(`[post_mind_change] shift detected: ${axis.label} (${Math.round(delta * 100)}pp)`);

  const tweet = await generateMindChangeTweet(axis, committed, delta, vocation);

  if (!tweet || tweet.length < 20) {
    console.log("[post_mind_change] LLM returned empty tweet — skipping");
    process.exit(0);
  }

  console.log(`[post_mind_change] tweet: ${tweet}`);

  if (!isDryRun) {
    const posted = postTweet(tweet);

    if (posted) {
      // Update committed state for this axis
      state.axes[axis.id] = {
        committed_score: axis.score,
        committed_at: new Date().toISOString(),
        evidence_count_at_post: (axis.evidence_log || []).length,
      };
      state.last_posted_at = new Date().toISOString();
      state.weekly_count = (state.weekly_count || 0) + 1;
      saveJson(MIND_STATE_PATH, state);
      console.log("[post_mind_change] mind-change tweet posted and state updated");
    }
  }

  process.exit(0);
})().catch(e => {
  console.error(`[post_mind_change] fatal: ${e.message}`);
  process.exit(0);
});
