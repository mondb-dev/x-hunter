#!/usr/bin/env node
/**
 * Diagnostic script for landmark detection.
 * Run: node runner/landmark/diag.js
 * Deletes itself after running.
 */
"use strict";

const db = require("../../scraper/db");
const raw = db.raw();
const { WINDOW_MS, MIN_POSTS_PER_WINDOW, STOP } = require("./config");
const { detect } = require("./detect");
const fs = require("fs");
const path = require("path");

// 1. Check data range
const since = Date.now() - 24 * 60 * 60 * 1000;
const posts = raw.prepare(
  `SELECT id, ts, username, text, likes, rts, replies, keywords, score
   FROM posts WHERE ts > ? AND text IS NOT NULL AND length(text) > 20
   ORDER BY ts ASC`
).all(since);
console.log(`\n=== LANDMARK DIAGNOSTIC ===`);
console.log(`Posts in last 24h: ${posts.length}`);

if (posts.length === 0) { console.log("No data — aborting"); process.exit(0); }

// 2. Window distribution
const windows = new Map();
for (const p of posts) {
  const winTs = Math.floor(p.ts / WINDOW_MS) * WINDOW_MS;
  if (!windows.has(winTs)) windows.set(winTs, []);
  windows.get(winTs).push(p);
}
const wList = Array.from(windows.entries()).sort((a,b) => a[0] - b[0]);
console.log(`\n2h windows: ${wList.length}`);
for (const [ts, ps] of wList) {
  console.log(`  ${new Date(ts).toISOString().slice(0,16)}: ${ps.length} posts`);
}

// 3. Volume z-scores
const counts = wList.map(([,ps]) => ps.length);
const rollingSize = Math.min(84, Math.max(3, Math.floor(wList.length / 3)));
console.log(`\nRolling window: ${rollingSize}`);
console.log(`\nVolume spikes (z > 1.5):`);
let spikeCount = 0;
for (let i = rollingSize; i < wList.length; i++) {
  const slice = counts.slice(i - rollingSize, i);
  const mean = slice.reduce((a,b) => a+b, 0) / slice.length;
  const std = Math.sqrt(slice.reduce((a,b) => a + (b-mean)**2, 0) / slice.length) || 1;
  const z = (counts[i] - mean) / std;
  if (z > 1.5) {
    console.log(`  ** ${new Date(wList[i][0]).toISOString().slice(0,16)}: z=${z.toFixed(2)} count=${counts[i]} mean=${mean.toFixed(1)}`);
    spikeCount++;
  }
}
if (spikeCount === 0) console.log("  (none)");

// 4. Run detect with progressively lower gates
console.log("\n=== Detection at different gates ===");
for (const gate of [4, 3, 2, 1]) {
  const events = detect(raw, { signalGateOverride: gate });
  console.log(`Gate ${gate}/6: ${events.length} event(s)`);
  for (const e of events.slice(0, 3)) {
    const sigs = Object.entries(e.signals).filter(([,v]) => v).map(([k]) => k);
    console.log(`  ${e.signalCount}/6 [${sigs.join(", ")}] kw: ${(e.topKeywords || []).slice(0,4).join(", ")}`);
  }
}

// 5. Try with 7-day lookback (full DB)
console.log("\n=== Full DB detection (7-day lookback) ===");
for (const gate of [3, 2]) {
  const events = detect(raw, { signalGateOverride: gate, lookbackMs: 7 * 24 * 60 * 60 * 1000 });
  console.log(`Gate ${gate}/6 (7d): ${events.length} event(s)`);
  for (const e of events.slice(0, 3)) {
    const sigs = Object.entries(e.signals).filter(([,v]) => v).map(([k]) => k);
    console.log(`  ${e.signalCount}/6 [${sigs.join(", ")}] kw: ${(e.topKeywords || []).slice(0,4).join(", ")}`);
  }
}

console.log("\n=== DONE ===\n");
