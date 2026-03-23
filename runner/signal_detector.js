#!/usr/bin/env node
/**
 * runner/signal_detector.js — cross-axis anomaly detection for structural stress
 *
 * Reads drift_alerts.jsonl and ontology.json to detect when multiple axes
 * spike simultaneously — a pattern that historically precedes major escalations
 * (e.g., 8+ axes spike on Mar 6 → oil tanker strikes + Hormuz closure by Mar 12).
 *
 * When an anomaly is detected:
 *   1. Writes state/signal_draft.txt with a natural-language summary
 *   2. The orchestrator picks this up and posts it as a `signal` type tweet
 *   3. Logs the signal to state/signal_log.jsonl for tracking
 *
 * Cooldown: max 1 signal per 48h to avoid crying wolf.
 * Threshold: configurable, default 6 axes (conservative — 8 was the confirmed pattern).
 *
 * Called by post_browse.js after detect_drift.js, every browse cycle.
 * Non-fatal: exits 0 on any error.
 *
 * Usage:
 *   node runner/signal_detector.js              # normal mode
 *   node runner/signal_detector.js --dry-run    # detect + log but don't write draft
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT         = path.resolve(__dirname, "..");
const DRIFT_ALERTS = path.join(ROOT, "state", "drift_alerts.jsonl");
const ONTO         = path.join(ROOT, "state", "ontology.json");
const SIGNAL_LOG   = path.join(ROOT, "state", "signal_log.jsonl");
const SIGNAL_DRAFT = path.join(ROOT, "state", "signal_draft.txt");

// ── Configuration ─────────────────────────────────────────────────────────────
const SPIKE_THRESHOLD    = 6;      // minimum distinct axes in 24h window to trigger
const COOLDOWN_HOURS     = 48;     // minimum hours between signal posts
const LOOKBACK_HOURS     = 24;     // rolling window for spike detection
const HIGH_SPIKE         = 8;      // "strong signal" threshold for language escalation

const isDryRun = process.argv.includes("--dry-run");

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

/**
 * Parse drift_alerts.jsonl and return alerts within the lookback window.
 */
function recentAlerts(hoursBack) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const alerts = [];
  try {
    const lines = fs.readFileSync(DRIFT_ALERTS, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const a = JSON.parse(line);
        if (new Date(a.ts).getTime() >= cutoff) alerts.push(a);
      } catch {}
    }
  } catch {}
  return alerts;
}

/**
 * Check cooldown: was a signal posted within COOLDOWN_HOURS?
 */
function isOnCooldown() {
  const cutoff = Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000;
  try {
    const lines = fs.readFileSync(SIGNAL_LOG, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (new Date(entry.ts).getTime() >= cutoff) return true;
      } catch {}
    }
  } catch {}
  return false;
}

/**
 * Count total evidence entries across all axes in the last 24h.
 */
function evidenceCount24h(onto) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let total = 0;
  for (const axis of (onto.axes || [])) {
    for (let i = (axis.evidence_log || []).length - 1; i >= 0; i--) {
      const ts = axis.evidence_log[i].timestamp || "";
      if (ts >= cutoff) total++;
      else break;
    }
  }
  return total;
}

/**
 * Build a human-readable signal draft from the spike data.
 */
function buildDraft(spikedAxes, totalEvidence, strength) {
  const axisNames = spikedAxes.map(a => a.label).slice(0, 5);
  const listStr = axisNames.join(", ");
  const moreCount = spikedAxes.length - axisNames.length;
  const moreStr = moreCount > 0 ? ` and ${moreCount} more` : "";

  if (strength === "strong") {
    return (
      `${spikedAxes.length} belief axes spiked in the last 24h — ` +
      `${listStr}${moreStr}. ${totalEvidence} evidence entries processed. ` +
      `When this has happened before, escalation followed within days. Watching closely.`
    );
  }

  return (
    `Structural stress signal: ${spikedAxes.length} axes showing correlated drift — ` +
    `${listStr}${moreStr}. ${totalEvidence} entries in 24h. ` +
    `This pattern has preceded escalations before. Noting it.`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

(function main() {
  const alerts = recentAlerts(LOOKBACK_HOURS);
  if (alerts.length === 0) {
    process.exit(0);
  }

  // Count distinct axes that alerted
  const axisIds = new Set(alerts.map(a => a.axis_id));

  if (axisIds.size < SPIKE_THRESHOLD) {
    // Below threshold — no signal
    process.exit(0);
  }

  // Check cooldown
  if (isOnCooldown()) {
    console.log(
      `[signal_detector] ${axisIds.size} axes spiked but cooldown active (${COOLDOWN_HOURS}h) — suppressed`
    );
    process.exit(0);
  }

  // Load ontology for axis labels and evidence count
  const onto = loadJson(ONTO);
  if (!onto) {
    console.log("[signal_detector] cannot load ontology.json — skipping");
    process.exit(0);
  }

  const axisMap = {};
  for (const a of (onto.axes || [])) axisMap[a.id] = a;

  const spikedAxes = [...axisIds].map(id => ({
    id,
    label: axisMap[id]?.label || id,
    score: axisMap[id]?.score ?? 0,
    confidence: axisMap[id]?.confidence ?? 0,
    direction: alerts.find(a => a.axis_id === id)?.direction || "unknown",
  }));

  // Sort by confidence descending (most established axes first)
  spikedAxes.sort((a, b) => b.confidence - a.confidence);

  const totalEvidence = evidenceCount24h(onto);
  const strength = axisIds.size >= HIGH_SPIKE ? "strong" : "moderate";

  // Build signal record
  const signalRecord = {
    ts: new Date().toISOString(),
    spike_count: axisIds.size,
    strength,
    evidence_24h: totalEvidence,
    axes: spikedAxes.map(a => ({
      id: a.id,
      direction: a.direction,
      score: a.score,
      confidence: a.confidence,
    })),
  };

  // Log the signal
  fs.appendFileSync(SIGNAL_LOG, JSON.stringify(signalRecord) + "\n", "utf-8");

  console.log(
    `[signal_detector] SIGNAL DETECTED: ${axisIds.size} axes spiked (${strength}), ` +
    `${totalEvidence} evidence entries in 24h`
  );

  // Write draft (unless dry run)
  if (!isDryRun) {
    const draft = buildDraft(spikedAxes, totalEvidence, strength);
    fs.writeFileSync(SIGNAL_DRAFT, draft, "utf-8");
    console.log(`[signal_detector] signal draft written to state/signal_draft.txt`);
  } else {
    console.log("[signal_detector] --dry-run: skipping draft write");
  }

  process.exit(0);
})();
