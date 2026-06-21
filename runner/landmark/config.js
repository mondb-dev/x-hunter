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

// ── Gate-based landmark tiers ─────────────────────────────────────────────────

/**
 * Landmark editions are now driven by publication gates rather than raw
 * signal-count rarity.
 *
 * candidate           -> internal only, no article, no NFT
 * tier_2              -> article signal, 30 editions
 * tier_1              -> NFT signal, 15 editions
 * special_vocation    -> vocation-change landmark, 3 editions
 * special_prediction  -> retroactively validated structural-signal landmark, 1 edition
 */
const LANDMARK_TIERS = {
  tier_2: {
    id: "tier_2",
    name: "Tier 2",
    label: "Article Signal",
    badge: "ARTICLE SIGNAL",
    editionSupply: 30,
    frame: "#C0C0C0",
    accent: "#8A8A9A",
    bg: "#16161E",
    glow: false,
  },
  tier_1: {
    id: "tier_1",
    name: "Tier 1",
    label: "NFT Signal",
    badge: "NFT SIGNAL",
    editionSupply: 15,
    frame: "#FFD700",
    accent: "#DAA520",
    bg: "#1A1508",
    glow: true,
  },
  special_vocation: {
    id: "special_vocation",
    name: "Special",
    label: "Vocation Change",
    badge: "VOCATION CHANGE",
    editionSupply: 3,
    frame: "#72F1B8",
    accent: "#2DBD8E",
    bg: "#0E1F1B",
    glow: true,
  },
  special_prediction: {
    id: "special_prediction",
    name: "Prediction",
    label: "Validated Structural Signal",
    badge: "VALIDATED SIGNAL",
    editionSupply: 1,
    frame: "#FF6B6B",
    accent: "#D9485F",
    bg: "#210F15",
    glow: true,
  },
};

/** Default price per collect in SOL */
const COLLECT_PRICE_SOL = 0.01;

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
  COLLECT_PRICE_SOL,
  LANDMARK_TIERS,
  STOP,
  PATHS,
};
