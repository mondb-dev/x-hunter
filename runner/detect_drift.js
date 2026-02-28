#!/usr/bin/env node
/**
 * runner/detect_drift.js — CUSUM change point detection on axis score history
 *
 * Reads state/ontology.json, reconstructs the score time-series from each axis's
 * evidence_log, applies a CUSUM (Cumulative Sum) algorithm to detect shifts in
 * belief trajectory. Writes alerts to state/drift_alerts.jsonl.
 *
 * CUSUM detects when evidence is consistently pushing in one direction beyond
 * a threshold, indicating a genuine belief shift rather than noise.
 *
 * Algorithm:
 *   For each new evidence entry (not previously detected):
 *     sign  = +1 (right) or -1 (left)
 *     C_pos += max(0, sign − k)      (CUSUM for rightward drift)
 *     C_neg += max(0, −sign − k)     (CUSUM for leftward drift)
 *   Alert when C_pos or C_neg exceeds threshold h.
 *   Reset after alert.
 *
 * Parameters (tunable):
 *   k = 0.5   — slack (half of minimum detectable shift)
 *   h = 4.0   — alert threshold (higher = fewer false positives)
 *
 * Usage:
 *   node runner/detect_drift.js               — check all axes
 *   node runner/detect_drift.js --axis axis_id — check one axis
 *
 * Called by run.sh after apply_ontology_delta on each tweet/browse cycle.
 * Non-fatal: errors are logged, not propagated.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT    = path.resolve(__dirname, "..");
const ONTO    = path.join(ROOT, "state", "ontology.json");
const ALERTS  = path.join(ROOT, "state", "drift_alerts.jsonl");
const STATE   = path.join(ROOT, "state", "drift_state.json");

// CUSUM parameters
const K = 0.5;  // slack — half of the minimum detectable shift in ±1 units
const H = 4.0;  // alert threshold — tune up to reduce false positives

// ── Load state ────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf-8"));
  } catch {
    return { axes: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf-8");
}

function appendAlert(alert) {
  fs.appendFileSync(ALERTS, JSON.stringify(alert) + "\n", "utf-8");
}

// ── CUSUM on evidence sequence ────────────────────────────────────────────────

/**
 * Process evidence entries not yet seen in the CUSUM state for this axis.
 * Returns array of {direction, cusum_value, evidence_count} alerts (may be empty).
 *
 * axisState: { processed_count, C_pos, C_neg }  (initialised to zeros if missing)
 * evidence_log: full log array from ontology
 */
function cusumAxis(axisState, evidenceLog) {
  const prevProcessed = axisState.processed_count || 0;
  const newEntries    = evidenceLog.slice(prevProcessed);
  if (newEntries.length === 0) return [];

  let C_pos = axisState.C_pos || 0;
  let C_neg = axisState.C_neg || 0;

  const alerts = [];
  let processed = prevProcessed;

  for (const entry of newEntries) {
    const sign = entry.pole_alignment === "right" ? 1 : -1;

    C_pos = Math.max(0, C_pos + sign - K);
    C_neg = Math.max(0, C_neg - sign - K);

    processed++;

    if (C_pos >= H) {
      alerts.push({ direction: "right", cusum_value: parseFloat(C_pos.toFixed(3)), evidence_index: processed });
      C_pos = 0; // reset after alert
    }
    if (C_neg >= H) {
      alerts.push({ direction: "left", cusum_value: parseFloat(C_neg.toFixed(3)), evidence_index: processed });
      C_neg = 0;
    }
  }

  // Persist updated CUSUM state
  axisState.processed_count = processed;
  axisState.C_pos           = parseFloat(C_pos.toFixed(4));
  axisState.C_neg           = parseFloat(C_neg.toFixed(4));

  return alerts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(function main() {
  if (!fs.existsSync(ONTO)) {
    console.log("[detect_drift] ontology.json not found — skipping");
    process.exit(0);
  }

  let onto;
  try {
    onto = JSON.parse(fs.readFileSync(ONTO, "utf-8"));
  } catch (e) {
    console.error(`[detect_drift] cannot parse ontology.json: ${e.message}`);
    process.exit(0);
  }

  const axes = onto.axes || [];
  if (axes.length === 0) {
    console.log("[detect_drift] no axes — skipping");
    process.exit(0);
  }

  // Optional: filter to one axis via CLI flag
  const axisArgIdx = process.argv.indexOf("--axis");
  const axisFlag   = axisArgIdx !== -1 ? process.argv[axisArgIdx + 1] : null;
  const targetAxes = axisFlag
    ? axes.filter(a => a.id === axisFlag)
    : axes;

  const state = loadState();
  if (!state.axes) state.axes = {};

  const now   = new Date().toISOString();
  let alertCount = 0;

  for (const axis of targetAxes) {
    const log = axis.evidence_log || [];
    if (log.length < 4) continue; // not enough data for CUSUM to be meaningful

    if (!state.axes[axis.id]) {
      state.axes[axis.id] = { processed_count: 0, C_pos: 0, C_neg: 0 };
    }

    const axisState = state.axes[axis.id];
    const alerts    = cusumAxis(axisState, log);

    for (const alert of alerts) {
      const record = {
        ts:             now,
        axis_id:        axis.id,
        axis_label:     axis.label,
        direction:      alert.direction,
        cusum_value:    alert.cusum_value,
        evidence_index: alert.evidence_index,
        current_score:  axis.score,
        confidence:     axis.confidence,
      };

      appendAlert(record);
      alertCount++;

      console.log(
        `[detect_drift] DRIFT DETECTED: "${axis.label}" → ${alert.direction} ` +
        `(CUSUM=${alert.cusum_value}, score=${axis.score})`
      );
    }
  }

  saveState(state);

  if (alertCount === 0) {
    console.log(`[detect_drift] ${targetAxes.length} axes checked — no drift detected`);
  } else {
    console.log(`[detect_drift] ${alertCount} drift alert(s) written to drift_alerts.jsonl`);
  }

  process.exit(0);
})();
