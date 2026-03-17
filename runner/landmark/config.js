/**
 * runner/landmark/config.js — shared constants and thresholds
 *
 * All tunable parameters for the landmark event pipeline live here.
 * Signal thresholds are adaptive: start permissive, tighten as data volume grows.
 */

"use strict";

// ── Detection window ──────────────────────────────────────────────────────────

/** Width of each analysis window in milliseconds (2 hours) */
const WINDOW_MS = 2 * 60 * 60 * 1000;

/** Minimum posts in a window to even consider it */
const MIN_POSTS_PER_WINDOW = 10;

// ── Signal thresholds ─────────────────────────────────────────────────────────

/**
 * Adaptive signal gate: how many of 6 signals must fire.
 * When daily post volume < VOLUME_THRESHOLD, use LOW; else use HIGH.
 */
const VOLUME_THRESHOLD = 5000;
const SIGNAL_GATE_LOW  = 3;   // ≥3/6 for sparse feeds
const SIGNAL_GATE_HIGH = 4;   // ≥4/6 once feed is mature

/** Per-signal thresholds */
const VOLUME_Z_SCORE_THRESHOLD = 3.0;
const CROSS_CLUSTER_MIN        = 2;
const VELOCITY_RATIO_MIN       = 2.0;
const NOVELTY_USER_MIN         = 3;
const NOVELTY_PRIOR_RATE_MAX   = 0.1;
const NOVELTY_KEYWORD_MIN      = 2;
const MULTI_AXIS_MIN           = 2;
const SENTIMENT_MULTIPLIER     = 3.0;

// ── Deduplication ─────────────────────────────────────────────────────────────

/** Minimum time between two landmarks on the same topic (12h) */
const DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;

// ── Cooldown ──────────────────────────────────────────────────────────────────

/** Minimum time between any two landmark mints (4h) */
const COOLDOWN_MS = 4 * 60 * 60 * 1000;

// ── Edition sizing ────────────────────────────────────────────────────────────

/**
 * Edition supply based on signal strength.
 * More signals → rarer edition → fewer copies.
 */
const EDITION_SUPPLY = {
  3: 1000,
  4: 500,
  5: 100,
  6: 25,
};

/** Default price per collect in SOL */
const COLLECT_PRICE_SOL = 0.01;

// ── Card tier colors ──────────────────────────────────────────────────────────

const CARD_TIERS = {
  3: { name: "Silver",      frame: "#C0C0C0", accent: "#8A8A8A", bg: "#1A1A2E" },
  4: { name: "Gold",        frame: "#FFD700", accent: "#B8860B", bg: "#1A1A2E" },
  5: { name: "Prismatic",   frame: "#E040FB", accent: "#7C4DFF", bg: "#0D0D1A" },
  6: { name: "Obsidian",    frame: "#FFD700", accent: "#1A1A1A", bg: "#000000" },
};

// ── Stopwords ─────────────────────────────────────────────────────────────────

const STOP = new Set([
  "this", "that", "they", "them", "their", "there", "these", "those",
  "about", "would", "could", "should", "will", "just", "like", "more",
  "been", "being", "have", "from", "what", "when", "where", "which",
  "with", "your", "than", "then", "into", "also", "some", "very",
  "much", "only", "even", "most", "here", "were", "other", "people",
  "going", "know", "want", "think", "make", "time", "back", "over",
  "after", "good", "need", "first", "well", "come", "right", "look",
  "still", "every", "never", "doing", "said", "says", "dont", "does",
  "didn", "hasn", "wasn", "https",
]);

// ── Paths ─────────────────────────────────────────────────────────────────────

const path = require("path");
const ROOT = path.resolve(__dirname, "../..");

const PATHS = {
  ROOT,
  STATE:           path.join(ROOT, "state"),
  ONTOLOGY:        path.join(ROOT, "state", "ontology.json"),
  TRUST_GRAPH:     path.join(ROOT, "state", "trust_graph.json"),
  LANDMARK_STATE:  path.join(ROOT, "state", "landmark_state.json"),
  LANDMARK_LOG:    path.join(ROOT, "state", "landmark_log.json"),
  ARWEAVE_LOG:     path.join(ROOT, "state", "arweave_log.json"),
  LANDMARKS_DIR:   path.join(ROOT, "landmarks"),
};

module.exports = {
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
  COOLDOWN_MS,
  EDITION_SUPPLY,
  COLLECT_PRICE_SOL,
  CARD_TIERS,
  STOP,
  PATHS,
};
