#!/usr/bin/env node
/**
 * scripts/retroactive_event_scan.js
 *
 * Scans historical post data to find potential landmark events.
 * Tests detection signals retroactively to validate the event detection approach.
 *
 * Signals tested:
 *   1. Volume anomaly — keyword volume exceeds 3σ above rolling 7-day average
 *   2. Cross-cluster convergence — ≥3 distinct clusters posting about same topic in 2h window
 *   3. Velocity — rate of posts on topic accelerating
 *   4. Novelty — keywords with low prior frequency suddenly spiking
 *   5. Multi-axis impact — topic maps to ≥2 belief axes
 *   6. Sentiment extremity — high engagement (likes+rts as proxy for emotional intensity)
 *
 * Usage: node scripts/retroactive_event_scan.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("../scraper/db");

const ROOT = path.resolve(__dirname, "..");

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

const d = db.raw();

// ── 1. Get all posts with timestamps, grouped into 2-hour windows ──────────

console.log("=== RETROACTIVE EVENT SCAN ===\n");

const allPosts = d.prepare(`
  SELECT id, ts, username, text, likes, rts, replies, keywords, score
  FROM posts
  WHERE text IS NOT NULL AND length(text) > 20
  ORDER BY ts ASC
`).all();

console.log(`Total posts: ${allPosts.length}`);
console.log(`Range: ${new Date(allPosts[0].ts).toISOString().slice(0, 10)} → ${new Date(allPosts[allPosts.length - 1].ts).toISOString().slice(0, 10)}\n`);

// ── 2. Build keyword frequency per 2-hour window ──────────────────────────

const WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// Extract keywords from text (simple: split on common delimiters, filter noise)
function extractTopics(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const words = lower
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3);
  
  // Bigrams for better topic detection
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(words[i] + " " + words[i + 1]);
  }
  return [...words, ...bigrams];
}

// Stopwords to filter
const STOP = new Set([
  "this", "that", "they", "them", "their", "there", "these", "those",
  "about", "would", "could", "should", "will", "just", "like", "more",
  "been", "being", "have", "from", "what", "when", "where", "which",
  "with", "your", "than", "then", "into", "also", "some", "very",
  "much", "only", "even", "most", "here", "were", "other", "people",
  "going", "know", "want", "think", "make", "time", "back", "over",
  "after", "good", "need", "first", "well", "come", "right", "look",
  "still", "every", "never", "doing", "said", "says", "dont", "does",
  "didn", "hasn", "wasn", "https"
]);

// ── 3. Group posts into 2-hour windows and count keyword frequencies ──────

const windows = new Map(); // windowKey → { ts, posts: [], keywords: Map<kw, Set<username>> }

for (const post of allPosts) {
  const windowTs = Math.floor(post.ts / WINDOW_MS) * WINDOW_MS;
  const key = windowTs.toString();
  
  if (!windows.has(key)) {
    windows.set(key, { ts: windowTs, posts: [], keywords: new Map() });
  }
  const win = windows.get(key);
  win.posts.push(post);
  
  const topics = extractTopics(post.text);
  for (const t of topics) {
    if (STOP.has(t) || t.length < 4) continue;
    if (!win.keywords.has(t)) win.keywords.set(t, new Set());
    win.keywords.get(t).add(post.username?.toLowerCase() || "unknown");
  }
}

console.log(`Windows (2h): ${windows.size}\n`);

// ── 4. Load trust graph for cluster mapping ───────────────────────────────

const trustGraph = loadJson(path.join(ROOT, "state", "trust_graph.json"), { accounts: {} });
const accountCluster = {};
for (const [user, data] of Object.entries(trustGraph.accounts || {})) {
  if (data.cluster) accountCluster[user.toLowerCase()] = data.cluster;
}

// ── 5. Load ontology for axis mapping ─────────────────────────────────────

const ontology = loadJson(path.join(ROOT, "state", "ontology.json"), { axes: [] });
const axisKeywords = {};
for (const axis of ontology.axes) {
  const terms = (axis.label + " " + axis.left_pole + " " + axis.right_pole)
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));
  axisKeywords[axis.id] = new Set(terms);
}

// ── 6. Compute rolling averages and detect anomalies ──────────────────────

const windowList = Array.from(windows.values()).sort((a, b) => a.ts - b.ts);
const ROLLING_WINDOWS = 84; // 7 days * 12 windows/day

const events = [];

for (let i = ROLLING_WINDOWS; i < windowList.length; i++) {
  const win = windowList[i];
  const postCount = win.posts.length;
  
  // Rolling average post count
  let rollingSum = 0;
  let rollingSumSq = 0;
  for (let j = i - ROLLING_WINDOWS; j < i; j++) {
    const c = windowList[j].posts.length;
    rollingSum += c;
    rollingSumSq += c * c;
  }
  const rollingMean = rollingSum / ROLLING_WINDOWS;
  const rollingStd = Math.sqrt(rollingSumSq / ROLLING_WINDOWS - rollingMean * rollingMean) || 1;
  
  // Signal 1: Volume anomaly (>3σ above mean)
  const volumeZScore = (postCount - rollingMean) / rollingStd;
  const volumeAnomaly = volumeZScore > 3;
  
  // Signal 2: Cross-cluster convergence
  // Find keywords mentioned by users from ≥3 different clusters
  const crossClusterTopics = [];
  for (const [kw, users] of win.keywords) {
    const clusters = new Set();
    for (const u of users) {
      if (accountCluster[u]) clusters.add(accountCluster[u]);
    }
    if (clusters.size >= 3) {
      crossClusterTopics.push({ keyword: kw, clusters: clusters.size, users: users.size });
    }
  }
  const crossCluster = crossClusterTopics.length > 0;
  
  // Signal 3: Velocity — compare to previous window
  const prevWin = windowList[i - 1];
  const velocityRatio = prevWin.posts.length > 0 ? postCount / prevWin.posts.length : 1;
  const velocitySpike = velocityRatio > 2; // 2x the previous window
  
  // Signal 4: Novelty — keywords that are rare in rolling history suddenly dominating
  const rollingKwFreq = new Map();
  for (let j = i - ROLLING_WINDOWS; j < i; j++) {
    for (const [kw] of windowList[j].keywords) {
      rollingKwFreq.set(kw, (rollingKwFreq.get(kw) || 0) + 1);
    }
  }
  let novelKeywords = 0;
  const topKws = Array.from(win.keywords.entries())
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 10);
  for (const [kw, users] of topKws) {
    const priorFreq = rollingKwFreq.get(kw) || 0;
    const priorRate = priorFreq / ROLLING_WINDOWS;
    if (users.size >= 3 && priorRate < 0.1) novelKeywords++; // appeared in <10% of prior windows
  }
  const novelty = novelKeywords >= 2;
  
  // Signal 5: Multi-axis impact
  const topKwStrings = topKws.map(([kw]) => kw);
  const impactedAxes = new Set();
  for (const [axisId, terms] of Object.entries(axisKeywords)) {
    for (const kw of topKwStrings) {
      const kwWords = kw.split(" ");
      for (const w of kwWords) {
        if (terms.has(w)) { impactedAxes.add(axisId); break; }
      }
    }
  }
  const multiAxis = impactedAxes.size >= 2;
  
  // Signal 6: Sentiment extremity (using engagement as proxy)
  const totalEngagement = win.posts.reduce((s, p) => s + (p.likes || 0) + (p.rts || 0), 0);
  const avgEngagement = totalEngagement / (postCount || 1);
  // Rolling average engagement
  let rollingEngSum = 0;
  let rollingEngCount = 0;
  for (let j = i - ROLLING_WINDOWS; j < i; j++) {
    for (const p of windowList[j].posts) {
      rollingEngSum += (p.likes || 0) + (p.rts || 0);
      rollingEngCount++;
    }
  }
  const rollingAvgEng = rollingEngCount > 0 ? rollingEngSum / rollingEngCount : 1;
  const sentimentExtreme = avgEngagement > rollingAvgEng * 3;
  
  // Count signals
  const signals = [
    volumeAnomaly, crossCluster, velocitySpike, novelty, multiAxis, sentimentExtreme
  ];
  const signalCount = signals.filter(Boolean).length;
  
  if (signalCount >= 3) {
    const date = new Date(win.ts);
    events.push({
      date: date.toISOString(),
      dateStr: date.toISOString().slice(0, 16).replace("T", " "),
      postCount,
      signalCount,
      volumeZ: volumeZScore.toFixed(1),
      signals: {
        volume: volumeAnomaly,
        crossCluster,
        velocity: velocitySpike,
        novelty,
        multiAxis,
        sentiment: sentimentExtreme,
      },
      topKeywords: topKws.slice(0, 5).map(([kw, u]) => `${kw} (${u.size} users)`),
      crossClusterTopics: crossClusterTopics.slice(0, 3).map(t => `${t.keyword} (${t.clusters} clusters)`),
      axesImpacted: Array.from(impactedAxes).slice(0, 4),
      sampleTexts: win.posts
        .sort((a, b) => (b.likes || 0) - (a.likes || 0))
        .slice(0, 3)
        .map(p => `@${p.username}: ${p.text?.slice(0, 120)}...`),
    });
  }
}

// ── 7. Deduplicate: merge events within 12h of each other ─────────────────

const DEDUP_MS = 12 * 60 * 60 * 1000;
const deduped = [];
for (const evt of events) {
  const ts = new Date(evt.date).getTime();
  const existing = deduped.find(e => Math.abs(new Date(e.date).getTime() - ts) < DEDUP_MS);
  if (existing) {
    // Keep the one with more signals
    if (evt.signalCount > existing.signalCount) {
      deduped[deduped.indexOf(existing)] = evt;
    }
  } else {
    deduped.push(evt);
  }
}

// ── 8. Output ─────────────────────────────────────────────────────────────

console.log(`\n=== DETECTED EVENTS (≥3/6 signals, deduped 12h) ===\n`);
console.log(`Found: ${deduped.length} potential landmark events\n`);

for (const evt of deduped) {
  const sigList = Object.entries(evt.signals)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  
  console.log(`━━━ ${evt.dateStr} UTC ━━━━━━━━━━━━━━━━━━`);
  console.log(`  Posts in window: ${evt.postCount} | Signals: ${evt.signalCount}/6 [${sigList}]`);
  console.log(`  Volume z-score: ${evt.volumeZ}`);
  console.log(`  Top keywords: ${evt.topKeywords.join(" | ")}`);
  if (evt.crossClusterTopics.length) {
    console.log(`  Cross-cluster: ${evt.crossClusterTopics.join(" | ")}`);
  }
  if (evt.axesImpacted.length) {
    console.log(`  Axes impacted: ${evt.axesImpacted.join(", ")}`);
  }
  console.log(`  Top posts:`);
  for (const t of evt.sampleTexts) console.log(`    ${t}`);
  console.log();
}

// Also write to file for easier review
const outPath = path.join(ROOT, "state", "retroactive_events.json");
fs.writeFileSync(outPath, JSON.stringify(deduped, null, 2));
console.log(`Written to ${outPath}`);
