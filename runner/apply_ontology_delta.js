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

const ROOT    = path.resolve(__dirname, "..");
const ONTO    = path.join(ROOT, "state", "ontology.json");
const DELTA   = path.join(ROOT, "state", "ontology_delta.json");
const TRUST   = path.join(ROOT, "state", "trust_graph.json");

const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

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

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body:    JSON.stringify({
        model:   OLLAMA_MODEL,
        prompt,
        stream:  false,
        options: { temperature: 0.0, num_predict: 80 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = (data.response || "").trim();

    // Extract JSON from response (may have markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);

    const conf = typeof parsed.confidence === "number" ? parsed.confidence : null;
    if (conf === null) throw new Error("confidence missing");

    return { confidence: conf, reasoning: parsed.reasoning || "" };
  } catch (err) {
    // Ollama error → accept entry (non-fatal)
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {

// ── Load trust graph ──────────────────────────────────────────────────────────
const trustMap = loadTrustMap();

// ── Load files ────────────────────────────────────────────────────────────────

let delta;
try {
  delta = JSON.parse(fs.readFileSync(DELTA, "utf-8"));
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
let axesAdded        = 0;

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

  // Compute trust weight from source URL account
  const sourceUser = usernameFromUrl(source);
  const weight     = trustWeight(sourceUser, trustMap);

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
}

// Recompute confidence and score using trust-weighted Bayesian update.
// Each evidence entry carries trust_weight (default 1.0 = trust_score/3).
// score      = Σ(w_i × ±1) / Σ(w_i)     — trust-weighted mean
// confidence = min(0.95, Σ(w_i) × 0.025) — effective evidence count drives confidence
for (const axis of onto.axes) {
  const log = axis.evidence_log || [];
  if (!log.length) continue;

  let weightedSum = 0;
  let totalWeight = 0;
  for (const e of log) {
    const w    = e.trust_weight ?? 1.0; // legacy entries without weight get 1.0
    const sign = e.pole_alignment === "right" ? 1 : -1;
    weightedSum += w * sign;
    totalWeight += w;
  }

  axis.score      = parseFloat((weightedSum / totalWeight).toFixed(4));
  axis.confidence = parseFloat(Math.min(0.95, totalWeight * 0.025).toFixed(4));
}

// ── Apply new axes ────────────────────────────────────────────────────────────

for (const raw of (delta.new_axes || [])) {
  if (!raw.id || !raw.label || !raw.left_pole || !raw.right_pole) {
    console.log(`[apply_delta] skipping malformed new_axis (missing required fields)`);
    continue;
  }

  if (axisById[raw.id]) {
    console.log(`[apply_delta] axis "${raw.id}" already exists — skipping new_axis`);
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
}

// ── Write back + cleanup ──────────────────────────────────────────────────────

onto.last_updated = now;

fs.writeFileSync(ONTO, JSON.stringify(onto, null, 2), "utf-8");
fs.unlinkSync(DELTA);

const rejMsg = evidenceRejected ? `, ${evidenceRejected} rejected by stance check` : "";
console.log(
  `[apply_delta] applied: ${evidenceAdded} evidence entry(ies)${rejMsg}, ${axesAdded} new axis(es)` +
  ` — total axes: ${onto.axes.length}`
);

})().catch(err => {
  console.error(`[apply_delta] fatal: ${err.message}`);
  process.exit(1);
});
