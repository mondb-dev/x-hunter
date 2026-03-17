/**
 * runner/landmark/state.js — landmark state persistence
 *
 * Manages:
 *   - landmark_state.json  (last detection timestamp, cooldown tracking)
 *   - landmark_log.json    (history of all minted landmarks)
 *
 * Pure data layer — no side effects beyond file I/O.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { PATHS, COOLDOWN_MS, DEDUP_WINDOW_MS } = require("./config");

// ── Landmark state (detection metadata) ───────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.LANDMARK_STATE, "utf-8"));
  } catch {
    return {
      enabled: false,              // pipeline disabled until explicitly turned on
      last_detection_at: null,     // ISO timestamp of last successful detection
      last_mint_at: null,          // ISO timestamp of last successful mint
      total_landmarks: 0,
      total_mints: 0,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(PATHS.LANDMARK_STATE, JSON.stringify(state, null, 2));
}

// ── Landmark log (immutable history) ──────────────────────────────────────────

function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.LANDMARK_LOG, "utf-8"));
  } catch {
    return { landmarks: [] };
  }
}

function appendLog(entry) {
  const log = loadLog();
  log.landmarks.push(entry);
  fs.writeFileSync(PATHS.LANDMARK_LOG, JSON.stringify(log, null, 2));
}

// ── Cooldown checks ───────────────────────────────────────────────────────────

/**
 * Returns true if enough time has passed since last mint.
 */
function isCooldownClear() {
  const state = loadState();
  if (!state.last_mint_at) return true;
  const elapsed = Date.now() - new Date(state.last_mint_at).getTime();
  return elapsed >= COOLDOWN_MS;
}

/**
 * Returns true if a similar event was already landed within the dedup window.
 * Similarity is checked by overlapping top keywords.
 */
function isDuplicate(topKeywords) {
  const log = loadLog();
  const now = Date.now();
  const kwSet = new Set(topKeywords.map(k => k.toLowerCase()));

  for (const entry of log.landmarks) {
    const entryTs = new Date(entry.detected_at).getTime();
    if (now - entryTs > DEDUP_WINDOW_MS) continue;

    const entryKws = new Set((entry.top_keywords || []).map(k => k.toLowerCase()));
    let overlap = 0;
    for (const kw of kwSet) {
      if (entryKws.has(kw)) overlap++;
    }
    // >50% keyword overlap = duplicate
    if (overlap >= Math.ceil(kwSet.size * 0.5)) return true;
  }
  return false;
}

/**
 * Record a successful detection + mint.
 */
function recordLandmark(event, mintResult) {
  const state = loadState();
  const now = new Date().toISOString();

  state.last_detection_at = now;
  state.last_mint_at = mintResult ? now : state.last_mint_at;
  state.total_landmarks++;
  if (mintResult) state.total_mints++;
  saveState(state);

  appendLog({
    id: `landmark_${state.total_landmarks}`,
    detected_at: now,
    signal_count: event.signalCount,
    signals: event.signals,
    top_keywords: event.topKeywords,
    headline: event.headline || null,
    arweave_tx: mintResult?.arweaveTx || null,
    mint_address: mintResult?.mintAddress || null,
    edition_supply: mintResult?.editionSupply || null,
    card_tier: event.cardTier || null,
  });
}

module.exports = {
  loadState,
  saveState,
  loadLog,
  appendLog,
  isCooldownClear,
  isDuplicate,
  recordLandmark,
};
