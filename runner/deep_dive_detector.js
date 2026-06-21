#!/usr/bin/env node
/**
 * runner/deep_dive_detector.js — auto-identify accounts/topics warranting a deep dive
 *
 * Scans browse_notes.md and ontology evidence_log for accounts that appear
 * repeatedly but have never been deep-dived. Queues the top candidate into
 * reading_queue.jsonl so the next browse cycle investigates them.
 *
 * Triggers: account mentioned ≥ MENTION_THRESHOLD times across browse notes + evidence
 * Exclusions: already consumed, already in-progress, own account, known noise accounts
 *
 * Usage: node runner/deep_dive_detector.js
 * Called by run.sh every 6 browse cycles (~2h).
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT         = path.resolve(__dirname, "..");
const BROWSE_NOTES = path.join(ROOT, "state", "browse_notes.md");
const ONTOLOGY     = path.join(ROOT, "state", "ontology.json");
const QUEUE_FILE   = path.join(ROOT, "state", "reading_queue.jsonl");

const MENTION_THRESHOLD = 3;   // minimum appearances to trigger deep dive
const MAX_QUEUE_DEPTH   = 3;   // don't queue more than this many pending deep dives at once

// Accounts to never deep dive (noise, own account, X system accounts)
const BLOCKLIST = new Set([
  "sebhunts_ai", "sebastianhunts", "x", "twitter", "verified", "support",
  "elonmusk",       // too noisy — already well-known signal
  "foxnews",        // institutional account — low personal signal
  "cnn", "bbc", "nytimes", "reuters", "ap",
]);

// ── Load queue ────────────────────────────────────────────────────────────────

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs.readFileSync(QUEUE_FILE, "utf-8")
    .split("\n").filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function appendQueue(entry) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

// ── Extract @mentions from text ───────────────────────────────────────────────

function extractMentions(text) {
  return (text.match(/@([A-Za-z0-9_]{2,})/g) || [])
    .map(m => m.slice(1).toLowerCase());
}

// ── Extract account handles from x.com evidence URLs ────────────────────────

function extractEvidenceAccounts(ontologyPath) {
  if (!fs.existsSync(ontologyPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(ontologyPath, "utf-8"));
    const handles = [];
    for (const axis of (data.axes || [])) {
      for (const ev of (axis.evidence_log || [])) {
        const src = ev.source || "";
        // x.com/handle/status/... → extract handle
        const m = src.match(/x\.com\/([A-Za-z0-9_]+)\/status\//);
        if (m) handles.push(m[1].toLowerCase());
      }
    }
    return handles;
  } catch { return []; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  // 1. Count mentions from browse_notes
  const notesMentions = fs.existsSync(BROWSE_NOTES)
    ? extractMentions(fs.readFileSync(BROWSE_NOTES, "utf-8"))
    : [];

  // 2. Count from ontology evidence sources
  const evidenceAccounts = extractEvidenceAccounts(ONTOLOGY);

  // 3. Combine and count
  const counts = new Map();
  for (const handle of [...notesMentions, ...evidenceAccounts]) {
    if (!handle || BLOCKLIST.has(handle)) continue;
    counts.set(handle, (counts.get(handle) || 0) + 1);
  }

  // 4. Load existing queue — aggregate status per URL
  //    JSONL stores state updates as separate lines (add → in_progress → consumed).
  //    We must correlate by URL to get the true status of each item.
  const queue = loadQueue();
  const urlStatus = new Map(); // url → { added, consumed, in_progress, from_user }
  for (const entry of queue) {
    const url = entry.url;
    if (!url) continue;
    if (!urlStatus.has(url)) urlStatus.set(url, {});
    const st = urlStatus.get(url);
    if (entry.from_user)         st.from_user = entry.from_user;
    if (entry.consumed_at)       st.consumed = true;
    if (entry.in_progress_cycle) st.in_progress = true;
    if (entry.added_at)          st.added = true;
  }

  const consumed = new Set();
  let pendingCount = 0;
  const alreadyQueued = new Set();

  for (const [url, st] of urlStatus) {
    const m = url.match(/x\.com\/([A-Za-z0-9_]+)\/?$/);
    const handle = m ? m[1].toLowerCase() : null;
    if (st.consumed) {
      if (handle) consumed.add(handle);
    } else if (st.from_user === "auto_detected") {
      pendingCount++;
      if (handle) alreadyQueued.add(handle);
    } else {
      if (handle) alreadyQueued.add(handle);
    }
  }

  if (pendingCount >= MAX_QUEUE_DEPTH) {
    console.log(`[deep_dive] queue has ${pendingCount} pending auto-detected items — skipping`);
    process.exit(0);
  }

  // 5. Find candidates above threshold not already consumed/queued

  const candidates = [...counts.entries()]
    .filter(([handle, count]) =>
      count >= MENTION_THRESHOLD &&
      !consumed.has(handle) &&
      !alreadyQueued.has(handle)
    )
    .sort((a, b) => b[1] - a[1]); // highest count first

  if (candidates.length === 0) {
    console.log(`[deep_dive] no candidates above threshold (${MENTION_THRESHOLD} mentions) — nothing to queue`);
    process.exit(0);
  }

  // 6. Queue top candidate
  const [topHandle, topCount] = candidates[0];
  const profileUrl = `https://x.com/${topHandle}`;
  appendQueue({
    url:         profileUrl,
    from_user:   "auto_detected",
    context:     `Appeared ${topCount} time(s) in recent browse notes and evidence — auto-queued for deep dive`,
    added_cycle: parseInt(process.env.READING_CYCLE || "0", 10),
    added_at:    new Date().toISOString(),
    priority:    "normal",
  });

  console.log(`[deep_dive] queued @${topHandle} for deep dive (${topCount} appearances)`);
  if (candidates.length > 1) {
    console.log(`[deep_dive] other candidates: ${candidates.slice(1, 4).map(([h, c]) => `@${h}(${c})`).join(", ")}`);
  }

  process.exit(0);
})().catch(err => {
  console.error(`[deep_dive] error: ${err.message}`);
  process.exit(0); // non-fatal
});
