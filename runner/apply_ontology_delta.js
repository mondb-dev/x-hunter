#!/usr/bin/env node
/**
 * runner/apply_ontology_delta.js — merge agent-written evidence deltas into ontology.json
 *
 * The browse/tweet agent writes state/ontology_delta.json with only NEW evidence
 * entries and/or new axes. This script merges them into state/ontology.json safely:
 *   - Validates pole_alignment via Ollama stance detection (skips low-confidence entries)
 *   - Appends validated evidence to existing axis evidence_logs (never clears)
 *   - Recomputes confidence and score from the full evidence_log after append
 *   - Adds new axes with proper initial state
 *   - Deletes ontology_delta.json after successful apply
 *
 * Stance detection: for each evidence entry with content >= 30 chars, calls Ollama
 * to confirm the pole_alignment is genuinely supported. Entries with confidence < 0.5
 * are rejected (logged). Ollama unavailable → accept entry (non-fatal fallback).
 *
 * Delta format (state/ontology_delta.json):
 * {
 *   "evidence": [
 *     { "axis_id": "axis_power_accountability",
 *       "source": "https://x.com/...",
 *       "content": "one-line description",
 *       "timestamp": "2026-02-28T13:00:00Z",
 *       "pole_alignment": "left" | "right"
 *     }, ...
 *   ],
 *   "new_axes": [
 *     { "id": "axis_new_thing", "label": "...", "left_pole": "...", "right_pole": "..." }
 *   ]
 * }
 *
 * Both "evidence" and "new_axes" are optional.
 * Unknown axis_ids in evidence are logged and skipped (not an error).
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT       = path.resolve(__dirname, "..");
const ONTO       = path.join(ROOT, "state", "ontology.json");
const DELTA      = path.join(ROOT, "state", "ontology_delta.json");
const TRUST      = path.join(ROOT, "state", "trust_graph.json");
const DRIFT_CAP  = path.join(ROOT, "state", "drift_cap_state.json");
const AXIS_GUARD = path.join(ROOT, "state", "axis_creation_state.json");
const DIVERSITY  = path.join(ROOT, "state", "diversity_state.json");

const { generate: llmGenerate } = require("./llm.js");
const { parseOntologyDelta } = require("./lib/ontology_delta.js");

// ── Diversity constraint (AGENTS.md §7) ───────────────────────────────────────
// Per 24h rolling window per axis:
//   dominant pole ≤ 70%  → diversity_weight = 1.0 (healthy)
//   dominant pole > 70%  → diversity_weight = 0.5 (dampen)
//   dominant pole > 90%  → pause updates entirely for that axis
// "Dominant" = whichever pole (left/right) has more evidence entries today.
const DIVERSITY_DAMPEN_THRESHOLD = 0.70;  // dominant > 70% → weight 0.5
const DIVERSITY_PAUSE_THRESHOLD  = 0.90;  // dominant > 90% → skip entry
const DIVERSITY_DAMPEN_WEIGHT    = 0.5;
const DIVERSITY_MIN_ENTRIES      = 4;     // need ≥4 entries to evaluate ratio

// Minimum evidence content length to warrant stance validation
const STANCE_MIN_CHARS = 30;
// Minimum Ollama-reported confidence to accept the alignment
const STANCE_MIN_CONF  = 0.50;

// Default trust score for unknown accounts (neutral prior)
const DEFAULT_TRUST = 3;
// Trust score of 3 = weight 1.0 (normalised to mean)
const TRUST_NORM    = DEFAULT_TRUST;

// ── Trust graph loader ────────────────────────────────────────────────────────

function loadTrustMap() {
  try {
    const data = JSON.parse(fs.readFileSync(TRUST, "utf-8"));
    const map  = new Map();
    for (const [username, acct] of Object.entries(data.accounts || {})) {
      map.set(username.toLowerCase(), acct.trust_score ?? DEFAULT_TRUST);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Extract @username from an x.com/status URL, or null. */
function usernameFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/x\.com\/([^\/?\s]+)\/status\//i);
  return m ? m[1].toLowerCase() : null;
}

/** Return trust weight [0.5, 2.0] normalised so default trust = 1.0. */
function trustWeight(username, trustMap) {
  const score = username ? (trustMap.get(username) ?? DEFAULT_TRUST) : DEFAULT_TRUST;
  // Clamp to [1, 5], normalise, clamp weight to [0.5, 2.0]
  return Math.min(2.0, Math.max(0.5, score / TRUST_NORM));
}

// ── Daily drift cap state ─────────────────────────────────────────────────────
// Tracks the score of each axis at the start of the current day.
// Prevents axis scores from moving more than ±0.05 per axis per day.

const DRIFT_CAP_PER_DAY = 0.05;
const TODAY_DATE = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

function loadDriftCapState(axes) {
  let state = { date: TODAY_DATE, scores: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(DRIFT_CAP, "utf-8"));
    if (raw.date === TODAY_DATE) {
      state = raw;
    } else {
      // New day — seed from current axis scores
      for (const a of axes) state.scores[a.id] = a.score ?? 0;
      fs.writeFileSync(DRIFT_CAP, JSON.stringify(state, null, 2), "utf-8");
    }
  } catch {
    // File missing — seed from current axis scores
    for (const a of axes) state.scores[a.id] = a.score ?? 0;
    fs.writeFileSync(DRIFT_CAP, JSON.stringify(state, null, 2), "utf-8");
  }
  return state;
}

function saveDriftCapState(state) {
  fs.writeFileSync(DRIFT_CAP, JSON.stringify(state, null, 2), "utf-8");
}

/** Clamp newScore so it does not move more than DRIFT_CAP_PER_DAY from baseScore. */
function applyDriftCap(axisId, newScore, driftState) {
  const base = driftState.scores[axisId] ?? 0;
  const clamped = Math.min(base + DRIFT_CAP_PER_DAY, Math.max(base - DRIFT_CAP_PER_DAY, newScore));
  if (clamped !== newScore) {
    console.log(
      `[apply_delta] drift cap hit on ${axisId}: ${newScore.toFixed(4)} → ${clamped.toFixed(4)}` +
      ` (base ${base.toFixed(4)} ±${DRIFT_CAP_PER_DAY})`
    );
  }
  return clamped;
}

// ── Axis creation guard ───────────────────────────────────────────────────────
// Enforces: max 3 new axes per day, semantic dedup (similarity > 0.86 → skip).

const MAX_AXES_PER_DAY = 3;

function loadAxisGuardState() {
  try {
    const raw = JSON.parse(fs.readFileSync(AXIS_GUARD, "utf-8"));
    if (raw.date === TODAY_DATE) return raw;
  } catch { /* ignore */ }
  // New day or missing file — reset
  const state = { date: TODAY_DATE, count: 0 };
  fs.writeFileSync(AXIS_GUARD, JSON.stringify(state, null, 2), "utf-8");
  return state;
}

function saveAxisGuardState(state) {
  fs.writeFileSync(AXIS_GUARD, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Tokenize a string into a set of lowercase words (stop-words stripped).
 * Used for Jaccard-based similarity as a proxy for cosine similarity on embeddings.
 */
const STOP = new Set(["the","a","an","and","or","of","in","is","are","that","to","for","with","on","by","at","from","as","this","it","its","which","vs","versus"]);
function tokenSet(str) {
  return new Set(
    (str || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
  );
}

/** Jaccard similarity between two token sets. */
function jaccardSim(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Compute combined text similarity between two axes based on label + left_pole + right_pole.
 * Returns a value in [0, 1]. Threshold 0.35 approximates cosine 0.86 on normalized text.
 */
const AXIS_SIMILARITY_THRESHOLD = 0.35;

function axisSimilarity(axisA, axisB) {
  const textA = `${axisA.label} ${axisA.left_pole} ${axisA.right_pole}`;
  const textB = `${axisB.label} ${axisB.left_pole} ${axisB.right_pole}`;
  return jaccardSim(tokenSet(textA), tokenSet(textB));
}

// ── Diversity constraint state ────────────────────────────────────────────────
// Tracks per-axis pole counts for the rolling 24h window.
// Loaded once per run; updated as evidence entries are accepted.

function loadDiversityState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DIVERSITY, "utf-8"));
    if (raw.date === TODAY_DATE) return raw;
  } catch { /* ignore */ }
  // New day or missing — reset
  return { date: TODAY_DATE, axes: {} };
}

function saveDiversityState(state) {
  fs.writeFileSync(DIVERSITY, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Seed diversity state from existing evidence_log entries timestamped today.
 * Called once after loading ontology so the first run of the day starts with
 * accurate counts (evidence may have been added in earlier cycles today).
 */
function seedDiversityFromLogs(diversityState, axes) {
  for (const axis of axes) {
    if (diversityState.axes[axis.id]) continue; // already seeded
    const log = axis.evidence_log || [];
    let left = 0, right = 0;
    for (const e of log) {
      if (e.timestamp && String(e.timestamp).startsWith(TODAY_DATE)) {
        if (e.pole_alignment === "left") left++;
        else if (e.pole_alignment === "right") right++;
      }
    }
    if (left + right > 0) {
      diversityState.axes[axis.id] = { left, right };
    }
  }
}

/**
 * Check the diversity constraint for a given axis and incoming pole_alignment.
 * Returns: { action: "accept"|"dampen"|"pause", weight: number, reason: string }
 */
function checkDiversity(axisId, poleAlignment, diversityState) {
  const counts = diversityState.axes[axisId] || { left: 0, right: 0 };
  const total  = counts.left + counts.right;

  // Not enough data to evaluate — accept at full weight
  if (total < DIVERSITY_MIN_ENTRIES) {
    return { action: "accept", weight: 1.0, reason: null };
  }

  const dominant    = Math.max(counts.left, counts.right);
  const dominantPole = counts.left >= counts.right ? "left" : "right";
  const ratio       = dominant / total;

  // If the incoming entry is on the dominant side AND ratio is skewed, act
  if (poleAlignment === dominantPole) {
    if (ratio >= DIVERSITY_PAUSE_THRESHOLD) {
      return {
        action: "pause",
        weight: 0,
        reason: `${dominantPole} pole at ${(ratio * 100).toFixed(0)}% (${dominant}/${total}) — paused`,
      };
    }
    if (ratio >= DIVERSITY_DAMPEN_THRESHOLD) {
      return {
        action: "dampen",
        weight: DIVERSITY_DAMPEN_WEIGHT,
        reason: `${dominantPole} pole at ${(ratio * 100).toFixed(0)}% (${dominant}/${total}) — dampened to ${DIVERSITY_DAMPEN_WEIGHT}`,
      };
    }
  }

  // Opposing pole or ratio is healthy — accept at full weight
  return { action: "accept", weight: 1.0, reason: null };
}

/** Record an accepted evidence entry in the diversity state. */
function recordDiversity(axisId, poleAlignment, diversityState) {
  if (!diversityState.axes[axisId]) diversityState.axes[axisId] = { left: 0, right: 0 };
  if (poleAlignment === "left") diversityState.axes[axisId].left++;
  else if (poleAlignment === "right") diversityState.axes[axisId].right++;
}

if (!fs.existsSync(DELTA)) {
  // Nothing to do — agent chose not to update ontology this cycle
  process.exit(0);
}

// ── Stance validation via Ollama ──────────────────────────────────────────────

async function validateStance(axis, content, poleAlignment) {
  const prompt =
`You are a fact-checker for an ontological belief system.

Axis: "${axis.label}"
Left pole: "${axis.left_pole}"
Right pole: "${axis.right_pole}"

Evidence: "${content}"
Claimed alignment: "${poleAlignment}" (${poleAlignment === "left" ? axis.left_pole : axis.right_pole})

Does this evidence genuinely support the claimed pole alignment?
Reply with JSON only, no other text:
{"confidence":0.0,"reasoning":"one sentence"}

confidence is 0.0–1.0 (1.0 = clearly supports the claimed alignment).`;

  try {
    const text = await llmGenerate(prompt, { temperature: 0.0, maxTokens: 80, timeoutMs: 10_000 });

    // Extract JSON from response (may have markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);

    const conf = typeof parsed.confidence === "number" ? parsed.confidence : null;
    if (conf === null) throw new Error("confidence missing");

    return { confidence: conf, reasoning: parsed.reasoning || "" };
  } catch (err) {
    // LLM error → accept entry (non-fatal)
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {

// ── Load trust graph ──────────────────────────────────────────────────────────
const trustMap = loadTrustMap();

// ── Load files ────────────────────────────────────────────────────────────────

let delta;
try {
  const raw = fs.readFileSync(DELTA, "utf-8");
  const parsed = parseOntologyDelta(raw);
  delta = parsed.delta;
  if (parsed.repaired) {
    console.log(
      `[apply_delta] repaired ontology_delta.json via ${parsed.method}` +
      ` (evidence=${delta.evidence.length}, new_axes=${delta.new_axes.length})`
    );
  }
} catch (e) {
  console.error(`[apply_delta] could not parse ontology_delta.json: ${e.message}`);
  fs.unlinkSync(DELTA);
  process.exit(0);
}

let onto;
try {
  onto = JSON.parse(fs.readFileSync(ONTO, "utf-8"));
} catch (e) {
  console.error(`[apply_delta] could not parse ontology.json: ${e.message}`);
  fs.unlinkSync(DELTA);
  process.exit(1);
}

if (!Array.isArray(onto.axes)) onto.axes = [];

const now = new Date().toISOString();
let evidenceAdded    = 0;
let evidenceRejected = 0;
let evidencePaused   = 0;
let evidenceDampened = 0;
let axesAdded        = 0;
let axesCapped       = 0;
const axesUpdated    = new Set(); // tracks which axes got new evidence this run

// ── Load daily drift cap + axis creation guard + diversity state ───────────────
const driftState     = loadDriftCapState(onto.axes);
const axisGuardState = loadAxisGuardState();
const diversityState = loadDiversityState();
seedDiversityFromLogs(diversityState, onto.axes);

// ── Apply evidence entries ────────────────────────────────────────────────────

const axisById = {};
for (const a of onto.axes) axisById[a.id] = a;

for (const entry of (delta.evidence || [])) {
  const { axis_id, source, content, timestamp, pole_alignment } = entry;

  if (!axis_id || !pole_alignment) {
    console.log(`[apply_delta] skipping malformed evidence entry (missing axis_id or pole_alignment)`);
    continue;
  }

  const axis = axisById[axis_id];
  if (!axis) {
    console.log(`[apply_delta] unknown axis_id "${axis_id}" — skipping evidence entry`);
    continue;
  }

  // ── Stance validation ───────────────────────────────────────────────────────
  let stanceConf = null;
  if ((content || "").length >= STANCE_MIN_CHARS) {
    const result = await validateStance(axis, content, pole_alignment);
    if (result !== null) {
      stanceConf = result.confidence;
      if (stanceConf < STANCE_MIN_CONF) {
        console.log(
          `[apply_delta] stance rejected (conf=${stanceConf.toFixed(2)}): ` +
          `"${(content || "").slice(0, 60)}" → ${pole_alignment} ` +
          `on "${axis.label}" — ${result.reasoning}`
        );
        evidenceRejected++;
        continue;
      }
    }
  }

  if (!Array.isArray(axis.evidence_log)) axis.evidence_log = [];

  // ── Diversity constraint (AGENTS.md §7) ───────────────────────────────────
  const divCheck = checkDiversity(axis_id, pole_alignment, diversityState);
  if (divCheck.action === "pause") {
    console.log(
      `[apply_delta] diversity PAUSED on ${axis_id}: ${divCheck.reason} — ` +
      `"${(content || "").slice(0, 50)}"`
    );
    evidencePaused++;
    continue;
  }
  if (divCheck.action === "dampen") {
    console.log(
      `[apply_delta] diversity DAMPENED on ${axis_id}: ${divCheck.reason}`
    );
    evidenceDampened++;
  }

  // Compute trust weight from source URL account
  const sourceUser = usernameFromUrl(source);
  const rawWeight  = trustWeight(sourceUser, trustMap);
  const weight     = parseFloat((rawWeight * divCheck.weight).toFixed(3));

  const logEntry = {
    source:         source    || "",
    content:        content   || "",
    timestamp:      timestamp || now,
    pole_alignment: pole_alignment,
    trust_weight:   parseFloat(weight.toFixed(3)),
  };
  if (stanceConf !== null) logEntry.stance_confidence = parseFloat(stanceConf.toFixed(3));

  axis.evidence_log.push(logEntry);
  evidenceAdded++;
  axis.last_updated = now;
  axesUpdated.add(axis.id);
  recordDiversity(axis.id, pole_alignment, diversityState);

  // ── Deferred: score_after + confidence_after added after recompute below ──
}

// Recompute confidence and score using trust-weighted Bayesian update.
// Only run on axes that received new evidence this call — axes with no new entries
// retain their accumulated score/confidence (the log may not contain the full history).
// score      = Σ(w_i × ±1) / Σ(w_i)     — trust-weighted mean
// confidence = min(0.95, Σ(w_i) × 0.025) — effective evidence count drives confidence
for (const axis of onto.axes) {
  if (!axesUpdated.has(axis.id)) continue;
  const log = axis.evidence_log || [];
  if (!log.length) continue;

  let weightedSum = 0;
  let totalWeight = 0;
  for (const e of log) {
    const w    = typeof e === "object" ? (e.trust_weight ?? 1.0) : 1.0;
    const sign = typeof e === "object" ? (e.pole_alignment === "right" ? 1 : -1)
                                       : (e >= 0 ? 1 : -1);
    weightedSum += w * sign;
    totalWeight += w;
  }

  const rawScore = parseFloat((weightedSum / totalWeight).toFixed(4));
  // Apply daily drift cap — score cannot move more than ±0.05 from start-of-day value
  axis.score      = parseFloat(applyDriftCap(axis.id, rawScore, driftState).toFixed(4));
  axis.confidence = parseFloat(Math.min(0.95, totalWeight * 0.025).toFixed(4));
  if (axis.score !== rawScore) axesCapped++;

  // ── Stamp score_after + confidence_after on newly added evidence entries ──
  // Walk backwards through evidence_log to find entries added this cycle (those
  // without score_after). This gives each entry the post-recompute snapshot.
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.score_after !== undefined) break; // hit previously stamped entries
    e.score_after      = axis.score;
    e.confidence_after = axis.confidence;
  }
}

// Persist updated drift cap state (scores reflect the clamped values for today)
saveDriftCapState(driftState);

// Persist diversity state (pole counts for today's rolling window)
saveDiversityState(diversityState);

// ── Apply new axes (with creation guard) ──────────────────────────────────────

for (const raw of (delta.new_axes || [])) {
  if (!raw.id || !raw.label || !raw.left_pole || !raw.right_pole) {
    console.log(`[apply_delta] skipping malformed new_axis (missing required fields)`);
    continue;
  }

  if (axisById[raw.id]) {
    console.log(`[apply_delta] axis "${raw.id}" already exists — skipping new_axis`);
    continue;
  }

  // ── Guard: max 3 new axes per day ─────────────────────────────────────────
  if (axisGuardState.count >= MAX_AXES_PER_DAY) {
    console.log(
      `[apply_delta] axis creation guard: daily limit (${MAX_AXES_PER_DAY}) reached — ` +
      `skipping new axis "${raw.id}"`
    );
    continue;
  }

  // ── Guard: semantic dedup — similarity > threshold → skip creation ─────────
  const nearDuplicate = onto.axes.find(existing => axisSimilarity(existing, raw) >= AXIS_SIMILARITY_THRESHOLD);
  if (nearDuplicate) {
    console.log(
      `[apply_delta] axis creation guard: "${raw.id}" is semantically similar to ` +
      `"${nearDuplicate.id}" (Jaccard >= ${AXIS_SIMILARITY_THRESHOLD}) — ` +
      `attach evidence to existing axis instead of creating a new one`
    );
    continue;
  }

  const newAxis = {
    id:           raw.id,
    label:        raw.label,
    left_pole:    raw.left_pole,
    right_pole:   raw.right_pole,
    score:        0,
    confidence:   0,
    topics:       Array.isArray(raw.topics) ? raw.topics : [],
    created_at:   now,
    last_updated: now,
    evidence_log: [],
  };

  onto.axes.push(newAxis);
  axisById[newAxis.id] = newAxis;
  axesAdded++;
  axisGuardState.count++;
}

// Persist updated axis creation guard state
saveAxisGuardState(axisGuardState);

// ── Reap dead axes: 0 evidence after 48h since creation ───────────────────────
const REAP_HOURS = 48;
const GRAVEYARD = path.join(ROOT, "state", "axes_graveyard.json");
const nowMs = Date.now();
const reaped = [];
onto.axes = onto.axes.filter(a => {
  const age = nowMs - new Date(a.created_at || now).getTime();
  const ageHours = age / (1000 * 60 * 60);
  if (ageHours >= REAP_HOURS && (a.evidence_log || []).length === 0) {
    reaped.push(a);
    return false;
  }
  return true;
});
if (reaped.length > 0) {
  let graveyard = [];
  try { graveyard = JSON.parse(fs.readFileSync(GRAVEYARD, "utf-8")); } catch {}
  graveyard.push(...reaped.map(a => ({ ...a, reaped_at: now })));
  fs.writeFileSync(GRAVEYARD, JSON.stringify(graveyard, null, 2), "utf-8");
  console.log(`[apply_delta] reaped ${reaped.length} dead axis(es): ${reaped.map(a => a.id).join(", ")}`);
}

// ── Write back + cleanup ──────────────────────────────────────────────────────

onto.last_updated = now;

fs.writeFileSync(ONTO, JSON.stringify(onto, null, 2), "utf-8");
fs.unlinkSync(DELTA);

const rejMsg    = evidenceRejected ? `, ${evidenceRejected} rejected by stance check` : "";
const cappedMsg = axesCapped ? `, ${axesCapped} drift-capped` : "";
const reapMsg   = reaped.length ? `, ${reaped.length} reaped` : "";
const pausedMsg = evidencePaused ? `, ${evidencePaused} paused by diversity` : "";
const dampenMsg = evidenceDampened ? `, ${evidenceDampened} dampened by diversity` : "";
console.log(
  `[apply_delta] applied: ${evidenceAdded} evidence entry(ies)${rejMsg}${pausedMsg}${dampenMsg}${cappedMsg}${reapMsg}, ${axesAdded} new axis(es)` +
  ` — total axes: ${onto.axes.length} (axes created today: ${axisGuardState.count}/${MAX_AXES_PER_DAY})`
);

})().catch(err => {
  console.error(`[apply_delta] fatal: ${err.message}`);
  process.exit(1);
});
