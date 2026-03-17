/**
 * runner/landmark/detect.js — event detection engine
 *
 * Scans recent posts in the SQLite database for landmark events using
 * 6 independent signals. Returns detected events sorted by signal strength.
 *
 * Signals:
 *   1. Volume anomaly — post count exceeds 3σ above rolling mean
 *   2. Cross-cluster convergence — ≥N clusters posting about same topic
 *   3. Velocity — rate of posts accelerating vs previous window
 *   4. Novelty — low-prior-frequency keywords suddenly spiking
 *   5. Multi-axis impact — topic maps to ≥2 belief axes
 *   6. Sentiment extremity — engagement spikes above 3x rolling average
 *
 * Pure function: takes DB handle, returns event objects. No side effects.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const {
  WINDOW_MS,
  MIN_POSTS_PER_WINDOW,
  VOLUME_THRESHOLD,
  SIGNAL_GATE_LOW,
  SIGNAL_GATE_HIGH,
  VOLUME_Z_SCORE_THRESHOLD,
  CROSS_CLUSTER_MIN,
  VELOCITY_RATIO_MIN,
  NOVELTY_USER_MIN,
  NOVELTY_PRIOR_RATE_MAX,
  NOVELTY_KEYWORD_MIN,
  MULTI_AXIS_MIN,
  SENTIMENT_MULTIPLIER,
  DEDUP_WINDOW_MS,
  STOP,
  PATHS,
} = require("./config");

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

/**
 * Extract topic words from post text.
 * Returns unigrams + bigrams, lowercased, URLs stripped.
 */
function extractTopics(text) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));

  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(words[i] + " " + words[i + 1]);
  }
  return [...words, ...bigrams];
}

/**
 * Build cluster map from trust graph.
 * Returns { username_lower: cluster_label }
 */
function buildClusterMap() {
  const tg = loadJson(PATHS.TRUST_GRAPH, { accounts: {} });
  const map = {};
  for (const [user, data] of Object.entries(tg.accounts || {})) {
    if (data.cluster) map[user.toLowerCase()] = data.cluster;
  }
  return map;
}

/**
 * Build axis keyword sets from ontology.
 * Returns { axis_id: Set<keyword> }
 */
function buildAxisKeywords() {
  const onto = loadJson(PATHS.ONTOLOGY, { axes: [] });
  const map = {};
  for (const axis of (onto.axes || [])) {
    const terms = (axis.label + " " + axis.left_pole + " " + axis.right_pole)
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w));
    map[axis.id] = new Set(terms);
  }
  return map;
}

// ── Signal computers ──────────────────────────────────────────────────────────

function computeVolume(postCount, rollingMean, rollingStd) {
  const zScore = (postCount - rollingMean) / (rollingStd || 1);
  return { zScore, fired: zScore > VOLUME_Z_SCORE_THRESHOLD };
}

function computeCrossCluster(keywords, clusterMap) {
  const topics = [];
  for (const [kw, users] of keywords) {
    const clusters = new Set();
    for (const u of users) {
      const c = clusterMap[u];
      if (c) clusters.add(c);
    }
    if (clusters.size >= CROSS_CLUSTER_MIN) {
      topics.push({ keyword: kw, clusters: clusters.size, users: users.size });
    }
  }
  return { topics, fired: topics.length > 0 };
}

function computeVelocity(currentCount, prevCount) {
  const ratio = prevCount > 0 ? currentCount / prevCount : 1;
  return { ratio, fired: ratio > VELOCITY_RATIO_MIN };
}

function computeNovelty(topKws, rollingKwFreq, rollingWindows) {
  let count = 0;
  for (const [kw, users] of topKws) {
    const priorFreq = rollingKwFreq.get(kw) || 0;
    const priorRate = priorFreq / rollingWindows;
    if (users.size >= NOVELTY_USER_MIN && priorRate < NOVELTY_PRIOR_RATE_MAX) count++;
  }
  return { count, fired: count >= NOVELTY_KEYWORD_MIN };
}

function computeMultiAxis(topKwStrings, axisKeywords) {
  const impacted = new Set();
  for (const [axisId, terms] of Object.entries(axisKeywords)) {
    for (const kw of topKwStrings) {
      for (const w of kw.split(" ")) {
        if (terms.has(w)) { impacted.add(axisId); break; }
      }
    }
  }
  return { axes: Array.from(impacted), fired: impacted.size >= MULTI_AXIS_MIN };
}

function computeSentiment(posts, rollingAvgEng) {
  const total = posts.reduce((s, p) => s + (p.likes || 0) + (p.rts || 0), 0);
  const avg = total / (posts.length || 1);
  return { avg, fired: avg > rollingAvgEng * SENTIMENT_MULTIPLIER };
}

// ── Main detection function ───────────────────────────────────────────────────

/**
 * Detect landmark events from the posts database.
 *
 * Uses the full lookback window (default 7d) to build rolling baselines,
 * but only emits events from the recent candidate window (default 6h)
 * to avoid re-detecting old events every run.
 *
 * @param {object} dbRaw - better-sqlite3 database handle (db.raw())
 * @param {object} [opts] - options
 * @param {number} [opts.lookbackMs] - how far back to scan for baseline stats (default: 7d)
 * @param {number} [opts.candidateMs] - only emit events within this recent window (default: 6h)
 * @param {number} [opts.signalGateOverride] - override the adaptive signal gate
 * @returns {Array<object>} detected events, sorted by signal count desc
 */
function detect(dbRaw, opts = {}) {
  const lookbackMs  = opts.lookbackMs  || 7 * 24 * 60 * 60 * 1000;  // 7 days for baseline
  const candidateMs = opts.candidateMs || 6 * 60 * 60 * 1000;        // 6h candidate window
  const since = Date.now() - lookbackMs;
  const candidateSince = Date.now() - candidateMs;

  // 1. Fetch posts
  const posts = dbRaw.prepare(`
    SELECT id, ts, username, text, likes, rts, replies, keywords, score
    FROM posts
    WHERE ts > ? AND text IS NOT NULL AND length(text) > 20
    ORDER BY ts ASC
  `).all(since);

  if (posts.length < MIN_POSTS_PER_WINDOW) {
    return [];
  }

  // 2. Group into 2h windows
  const windows = new Map();
  for (const post of posts) {
    const winTs = Math.floor(post.ts / WINDOW_MS) * WINDOW_MS;
    const key = winTs.toString();
    if (!windows.has(key)) {
      windows.set(key, { ts: winTs, posts: [], keywords: new Map() });
    }
    const win = windows.get(key);
    win.posts.push(post);

    for (const t of extractTopics(post.text)) {
      if (!win.keywords.has(t)) win.keywords.set(t, new Set());
      win.keywords.get(t).add((post.username || "unknown").toLowerCase());
    }
  }

  const windowList = Array.from(windows.values()).sort((a, b) => a.ts - b.ts);

  // Need at least a few windows for meaningful rolling average
  if (windowList.length < 4) return [];

  // Adaptive rolling window: 1/3 of available data
  const rollingSize = Math.min(84, Math.max(3, Math.floor(windowList.length / 3)));

  // 3. Load context (cluster map + axis keywords)
  const clusterMap = buildClusterMap();
  const axisKws = buildAxisKeywords();

  // 4. Determine signal gate from daily volume
  const totalPosts = posts.length;
  const daySpan = (posts[posts.length - 1].ts - posts[0].ts) / (24 * 60 * 60 * 1000) || 1;
  const dailyVolume = totalPosts / daySpan;
  const signalGate = dailyVolume >= VOLUME_THRESHOLD ? SIGNAL_GATE_HIGH : SIGNAL_GATE_LOW;

  // 5. Scan windows
  const events = [];

  for (let i = rollingSize; i < windowList.length; i++) {
    const win = windowList[i];
    if (win.posts.length < MIN_POSTS_PER_WINDOW) continue;

    // Rolling stats
    let rollingSum = 0, rollingSumSq = 0;
    let rollingEngSum = 0, rollingEngCount = 0;
    const rollingKwFreq = new Map();

    for (let j = i - rollingSize; j < i; j++) {
      const rw = windowList[j];
      const c = rw.posts.length;
      rollingSum += c;
      rollingSumSq += c * c;
      for (const p of rw.posts) {
        rollingEngSum += (p.likes || 0) + (p.rts || 0);
        rollingEngCount++;
      }
      for (const [kw] of rw.keywords) {
        rollingKwFreq.set(kw, (rollingKwFreq.get(kw) || 0) + 1);
      }
    }

    const rollingMean = rollingSum / rollingSize;
    const rollingStd = Math.sqrt(rollingSumSq / rollingSize - rollingMean * rollingMean) || 1;
    const rollingAvgEng = rollingEngCount > 0 ? rollingEngSum / rollingEngCount : 1;

    // Top keywords by unique users
    const topKws = Array.from(win.keywords.entries())
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 10);
    const topKwStrings = topKws.map(([kw]) => kw);

    // Compute all 6 signals
    const volume    = computeVolume(win.posts.length, rollingMean, rollingStd);
    const cluster   = computeCrossCluster(win.keywords, clusterMap);
    const velocity  = computeVelocity(win.posts.length, windowList[i - 1].posts.length);
    const novelty   = computeNovelty(topKws, rollingKwFreq, rollingSize);
    const multiAxis = computeMultiAxis(topKwStrings, axisKws);
    const sentiment = computeSentiment(win.posts, rollingAvgEng);

    const signalFlags = {
      volume:       volume.fired,
      crossCluster: cluster.fired,
      velocity:     velocity.fired,
      novelty:      novelty.fired,
      multiAxis:    multiAxis.fired,
      sentiment:    sentiment.fired,
    };
    const signalCount = Object.values(signalFlags).filter(Boolean).length;

    // Only emit events from the recent candidate window (skip old baseline windows)
    if (signalCount >= signalGate && win.ts >= candidateSince) {
      const date = new Date(win.ts);
      events.push({
        date: date.toISOString(),
        dateStr: date.toISOString().slice(0, 16).replace("T", " "),
        windowTs: win.ts,
        postCount: win.posts.length,
        signalCount,
        signalGate,
        signals: signalFlags,
        stats: {
          volumeZ:      parseFloat(volume.zScore.toFixed(2)),
          velocityRatio: parseFloat(velocity.ratio.toFixed(2)),
          noveltyCount: novelty.count,
          axesImpacted: multiAxis.axes,
          sentimentAvg: parseFloat(sentiment.avg.toFixed(2)),
          crossClusterTopics: cluster.topics.slice(0, 5),
        },
        topKeywords: topKws.slice(0, 5).map(([kw, u]) => kw),
        topKeywordsDetail: topKws.slice(0, 5).map(([kw, u]) => ({
          keyword: kw, users: u.size,
        })),
        samplePosts: win.posts
          .sort((a, b) => (b.likes || 0) + (b.rts || 0) - (a.likes || 0) - (a.rts || 0))
          .slice(0, 5)
          .map(p => ({
            username: p.username,
            text: p.text?.slice(0, 200),
            likes: p.likes || 0,
            rts: p.rts || 0,
          })),
      });
    }
  }

  // 6. Deduplicate within 12h
  const deduped = [];
  for (const evt of events) {
    const ts = new Date(evt.date).getTime();
    const existing = deduped.find(e =>
      Math.abs(new Date(e.date).getTime() - ts) < DEDUP_WINDOW_MS
    );
    if (existing) {
      if (evt.signalCount > existing.signalCount) {
        deduped[deduped.indexOf(existing)] = evt;
      }
    } else {
      deduped.push(evt);
    }
  }

  return deduped.sort((a, b) => b.signalCount - a.signalCount);
}

module.exports = { detect };
