#!/usr/bin/env node
/**
 * runner/daily_snapshot.js — capture a full ontology state snapshot
 *
 * Writes state/snapshots/YYYY-MM-DD.json with score, confidence, evidence count,
 * velocity, and cross-axis spike data for every axis. ~2KB per day.
 *
 * Called once per day from lib/daily.js (daily maintenance block).
 * Also callable standalone: node runner/daily_snapshot.js
 *
 * Non-fatal: exits 0 on any error after logging.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT          = path.resolve(__dirname, "..");
const ONTO          = path.join(ROOT, "state", "ontology.json");
const SNAPSHOTS_DIR = path.join(ROOT, "state", "snapshots");
const DRIFT_ALERTS  = path.join(ROOT, "state", "drift_alerts.jsonl");

const today = new Date().toISOString().slice(0, 10);

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

/**
 * Count evidence entries added today for a given axis.
 */
function evidenceToday(axis) {
  const log = axis.evidence_log || [];
  let count = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const ts = log[i].timestamp || "";
    if (String(ts).startsWith(today)) count++;
    else if (count > 0) break; // entries are chronological — stop when we pass today
  }
  return count;
}

/**
 * Compute velocity: score change over the last 24h of evidence.
 * Uses score_after stamps if available, otherwise approximates from pole_alignment.
 */
function computeVelocity(axis) {
  const log = axis.evidence_log || [];
  if (log.length < 2) return 0;

  // Find the oldest score_after stamp from today
  let earliestScore = null;
  for (const e of log) {
    if (String(e.timestamp || "").startsWith(today) && e.score_after !== undefined) {
      earliestScore = e.score_after;
      break;
    }
  }

  if (earliestScore !== null) {
    return parseFloat(((axis.score ?? 0) - earliestScore).toFixed(4));
  }

  // Fallback: count net pole alignment today
  let net = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (!String(log[i].timestamp || "").startsWith(today)) break;
    net += log[i].pole_alignment === "right" ? 1 : -1;
  }
  const total = log.length || 1;
  return parseFloat((net / total * 0.05).toFixed(4)); // rough estimate
}

/**
 * Count how many axes had drift alerts today (cross-axis spike detection).
 */
function countSpikeAxesToday() {
  const spikedAxes = new Set();
  try {
    const lines = fs.readFileSync(DRIFT_ALERTS, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const alert = JSON.parse(line);
        if (String(alert.ts || "").startsWith(today)) {
          spikedAxes.add(alert.axis_id);
        }
      } catch {}
    }
  } catch {}
  return spikedAxes;
}

(function main() {
  const onto = loadJson(ONTO);
  if (!onto || !Array.isArray(onto.axes)) {
    console.log("[daily_snapshot] ontology.json not found or invalid — skipping");
    process.exit(0);
  }

  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  const outPath = path.join(SNAPSHOTS_DIR, `${today}.json`);

  // Don't overwrite if already taken today (idempotent)
  if (fs.existsSync(outPath)) {
    console.log(`[daily_snapshot] ${today}.json already exists — skipping`);
    process.exit(0);
  }

  const spikedAxes = countSpikeAxesToday();

  // Compute day number from agent start date
  const agentStartMs = new Date("2026-02-23T00:00:00Z").getTime();
  const todayMs      = new Date(today + "T00:00:00Z").getTime();
  const dayNumber    = Math.floor((todayMs - agentStartMs) / 86400000) + 1;

  const snapshot = {
    date: today,
    day: dayNumber,
    taken_at: new Date().toISOString(),
    axes_count: onto.axes.length,
    cross_axis_spike: spikedAxes.size >= 6,
    spike_count: spikedAxes.size,
    spiked_axes: [...spikedAxes],
    axes: onto.axes.map(a => ({
      id:             a.id,
      label:          a.label,
      score:          parseFloat((a.score ?? 0).toFixed(4)),
      confidence:     parseFloat((a.confidence ?? 0).toFixed(4)),
      evidence_count: (a.evidence_log || []).length,
      evidence_24h:   evidenceToday(a),
      velocity:       computeVelocity(a),
    })),
  };

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log(
    `[daily_snapshot] ${today}.json written — ${onto.axes.length} axes, ` +
    `spike_count=${spikedAxes.size}, day=${dayNumber}`
  );
  process.exit(0);
})();
