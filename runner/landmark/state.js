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

const ATTEMPTS_PATH = path.join(PATHS.STATE, "landmark_attempts.json");

// ── Landmark state (detection metadata) ───────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.LANDMARK_STATE, "utf-8"));
  } catch {
    return {
      enabled: false,              // pipeline disabled until explicitly turned on
      last_detection_at: null,     // ISO timestamp of last successful detection
      last_publish_at: null,       // ISO timestamp of last published article
      last_mint_at: null,          // ISO timestamp of last successful mint
      total_landmarks: 0,
      total_mints: 0,
      total_candidates: 0,
      total_published: 0,
      total_minted: 0,
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

// ── Attempt ledger (non-publishing outcomes) ──────────────────────────────────
//
// Records events that were processed but did NOT publish (validation/grounding
// failure, publish failure). The published-landmark log only records successes,
// so without this ledger a failed event would be re-detected and re-generated
// (re-paying for editorial + art) on every scan until it aged out of the
// candidate window.

function loadAttempts() {
  try {
    return JSON.parse(fs.readFileSync(ATTEMPTS_PATH, "utf-8"));
  } catch {
    return { attempts: [] };
  }
}

function recordAttempt(event, status, reason) {
  const data = loadAttempts();
  data.attempts.push({
    detected_at: new Date().toISOString(),
    window_ts: event.windowTs || null,
    top_keywords: event.topKeywords || [],
    status,                       // validation_failed | grounding_failed | publish_failed
    reason: reason || null,
  });
  // Bound file growth — keep the most recent 200 attempts.
  if (data.attempts.length > 200) data.attempts = data.attempts.slice(-200);
  fs.writeFileSync(ATTEMPTS_PATH, JSON.stringify(data, null, 2));
}

// ── Cooldown checks ───────────────────────────────────────────────────────────

/**
 * Returns true if enough time has passed since the last landmark was
 * published or minted (whichever is more recent).
 *
 * Note: this previously keyed only off `last_mint_at`. Because minting is
 * disabled, that timestamp is never set, which silently disabled the cooldown
 * entirely. Publication now drives the cooldown too.
 */
function isCooldownClear() {
  const state = loadState();
  const stamps = [state.last_publish_at, state.last_mint_at]
    .filter(Boolean)
    .map(t => new Date(t).getTime())
    .filter(t => !Number.isNaN(t));
  if (stamps.length === 0) return true;
  const elapsed = Date.now() - Math.max(...stamps);
  return elapsed >= COOLDOWN_MS;
}

/** True if `topKeywords` overlaps a prior entry's keywords by >50%. */
function keywordOverlapDuplicate(kwSet, entryKeywords) {
  const entryKws = new Set((entryKeywords || []).map(k => String(k).toLowerCase()));
  let overlap = 0;
  for (const kw of kwSet) {
    if (entryKws.has(kw)) overlap++;
  }
  return overlap >= Math.ceil(kwSet.size * 0.5);
}

/**
 * Returns true if a similar event was already published OR recently attempted
 * (and failed) within the dedup window. Similarity is >50% top-keyword overlap.
 *
 * Previously this only consulted the published-landmark log, so a failed-publish
 * event was re-detected and re-processed every scan. It now also consults the
 * attempt ledger.
 */
function isDuplicate(topKeywords) {
  const now = Date.now();
  const kwSet = new Set((topKeywords || []).map(k => k.toLowerCase()));
  if (kwSet.size === 0) return false;

  // Published landmarks
  for (const entry of loadLog().landmarks) {
    const entryTs = new Date(entry.detected_at).getTime();
    if (now - entryTs > DEDUP_WINDOW_MS) continue;
    if (keywordOverlapDuplicate(kwSet, entry.top_keywords)) return true;
  }

  // Recent non-publishing attempts
  for (const a of loadAttempts().attempts) {
    const ts = new Date(a.detected_at).getTime();
    if (now - ts > DEDUP_WINDOW_MS) continue;
    if (keywordOverlapDuplicate(kwSet, a.top_keywords)) return true;
  }

  return false;
}

/**
 * Record landmark lifecycle data.
 */
function recordLandmark(event, mintResult, meta = {}) {
  const state = loadState();
  const now = new Date().toISOString();

  state.last_detection_at = now;
  state.last_publish_at = meta.published ? now : (state.last_publish_at || null);
  state.last_mint_at = mintResult ? now : state.last_mint_at;
  state.total_landmarks++;
  state.total_candidates = (state.total_candidates || 0) + 1;
  if (meta.published) state.total_published = (state.total_published || 0) + 1;
  if (mintResult) state.total_mints++;
  if (mintResult) state.total_minted = (state.total_minted || 0) + 1;
  saveState(state);

  appendLog({
    id: `landmark_${state.total_landmarks}`,
    detected_at: now,
    stage: event.landmarkStage || meta.stage || null,
    tier: event.landmarkTierKey || meta.tier || null,
    signal_count: event.signalCount,
    signals: event.signals,
    top_keywords: event.topKeywords,
    headline: event.headline || null,
    arweave_tx: mintResult?.arweaveTx || null,
    mint_address: mintResult?.mintAddress || null,
    edition_supply: mintResult?.editionSupply || meta.editionSupply || null,
    card_tier: event.landmarkTierKey || meta.tier || null,
    article_url: meta.articleUrl || null,
  });
}

module.exports = {
  loadState,
  saveState,
  loadLog,
  appendLog,
  loadAttempts,
  recordAttempt,
  isCooldownClear,
  isDuplicate,
  recordLandmark,
};
