#!/usr/bin/env node
/**
 * runner/predictive_prompt.js — generate a prediction tweet from observed patterns
 *
 * Reads ontology axes with recent drift, evidence logs, and signal history
 * to produce a short prediction about what may happen next. This is Sebastian's
 * "I think X is about to happen because I've observed Y" feature.
 *
 * Cooldown: max 1 prediction per 24h.
 * Called by post_browse.js after signal_detector, every browse cycle.
 * Non-fatal: exits 0 on any error.
 *
 * Writes state/prediction_draft.txt if a prediction is warranted.
 *
 * Usage:
 *   node runner/predictive_prompt.js
 *   node runner/predictive_prompt.js --dry-run
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT              = path.resolve(__dirname, "..");
const ONTO_PATH         = path.join(ROOT, "state", "ontology.json");
const DRIFT_ALERTS_PATH = path.join(ROOT, "state", "drift_alerts.jsonl");
const SIGNAL_LOG_PATH   = path.join(ROOT, "state", "signal_log.jsonl");
const PREDICTION_LOG    = path.join(ROOT, "state", "prediction_log.jsonl");
const PREDICTION_DRAFT  = path.join(ROOT, "state", "prediction_draft.txt");
const VOCATION_PATH     = path.join(ROOT, "state", "vocation.json");

const { callVertex } = require("./vertex.js");

// ── Configuration ────────────────────────────────────────────────────────────
const COOLDOWN_HOURS    = 24;    // max 1 prediction per day
const MIN_DRIFTING_AXES = 3;     // need at least 3 axes with recent drift to attempt
const LOOKBACK_HOURS    = 48;    // window for gathering drift evidence

const isDryRun = process.argv.includes("--dry-run");

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function isOnCooldown() {
  const cutoff = Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000;
  try {
    const lines = fs.readFileSync(PREDICTION_LOG, "utf-8").split("\n").filter(Boolean);
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
 * Get axes that have drifted recently (from drift_alerts.jsonl).
 */
function getDriftingAxes(onto) {
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const driftMap = new Map(); // axis_id → { direction, count, latest_ts }

  try {
    const lines = fs.readFileSync(DRIFT_ALERTS_PATH, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const a = JSON.parse(line);
        const ts = new Date(a.ts).getTime();
        if (ts < cutoff) continue;
        const existing = driftMap.get(a.axis_id);
        if (!existing || ts > new Date(existing.latest_ts).getTime()) {
          driftMap.set(a.axis_id, {
            direction: a.direction || "unknown",
            count: (existing?.count || 0) + 1,
            latest_ts: a.ts,
          });
        }
      } catch {}
    }
  } catch {}

  // Enrich with ontology data
  const axisMap = {};
  for (const a of (onto.axes || [])) axisMap[a.id] = a;

  return [...driftMap.entries()]
    .map(([id, drift]) => ({
      id,
      label: axisMap[id]?.label || id,
      score: axisMap[id]?.score ?? 0,
      confidence: axisMap[id]?.confidence ?? 0,
      pole_left: axisMap[id]?.pole_left || "",
      pole_right: axisMap[id]?.pole_right || "",
      direction: drift.direction,
      drift_count: drift.count,
      recent_evidence: (axisMap[id]?.evidence_log || []).slice(-3).map(e => e.content || "").filter(Boolean),
    }))
    .sort((a, b) => b.drift_count - a.drift_count);
}

/**
 * Get recent signals for context.
 */
function recentSignals() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  const signals = [];
  try {
    const lines = fs.readFileSync(SIGNAL_LOG_PATH, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        if (new Date(s.ts).getTime() >= cutoff) signals.push(s);
      } catch {}
    }
  } catch {}
  return signals;
}

/**
 * Load recent browse notes for additional grounding context.
 */
function recentBrowseContext() {
  const notesPath = path.join(ROOT, "state", "browse_notes.md");
  try {
    const raw = fs.readFileSync(notesPath, "utf-8");
    // Take last 60 non-empty lines to get recent cycle observations
    const lines = raw.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("[NOTED]"));
    return lines.slice(-60).join("\n").slice(0, 2000);
  } catch { return ""; }
}

async function generatePrediction(driftingAxes, signals, vocation) {
  // Build rich evidence context: axis label + actual evidence text
  const axesSummary = driftingAxes.slice(0, 6).map(a => {
    const evidence = a.recent_evidence.length > 0
      ? `\n    Recent observations: ${a.recent_evidence.join(" | ").slice(0, 300)}`
      : "";
    return `  - ${a.label} (drifting ${a.direction}, ${a.drift_count} alerts in 48h)${evidence}`;
  }).join("\n");

  const browseContext = recentBrowseContext();
  const browseSection = browseContext
    ? `\nRecent browse observations that are driving the drift:\n${browseContext}`
    : "";

  const vocLabel = vocation?.label || "Digital Watchdog for Public Integrity";

  const prompt = `You are Sebastian D. Hunter, an autonomous AI agent whose vocation is "${vocLabel}".

You observe public discourse and track belief axes. The following topics have been shifting in discourse intensity over the last 48 hours:

${axesSummary}
${browseSection}

Based on the SPECIFIC EVENTS AND ACTORS you see above, write a SHORT prediction tweet (max 260 characters).

RULES:
- Name a SPECIFIC actor, country, institution, or event (e.g. "Iran", "Congress", "Swalwell", "the Strait of Hormuz") — do NOT reference your own axes or belief system
- State what you predict will happen in the real world and WHY based on the pattern
- Be concrete and falsifiable (reader should be able to check if you were right)
- End with a timeframe ("within days", "this week", "within 72 hours", etc.)
- Sound like a watchdog analyst citing observed patterns, not a pundit or pundit-quoting bot
- Do NOT say "my axes", "belief drift", "correlated axes", "axis", or any internal system language
- Do NOT use hashtags or emojis
- Write in first person

Return ONLY the tweet text, nothing else.`;

  const raw = await callVertex(prompt, 512);
  return raw.trim().replace(/^["']|["']$/g, ""); // strip wrapping quotes
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async function main() {
  try {
    if (isOnCooldown()) {
      process.exit(0);
    }

    const onto = loadJson(ONTO_PATH);
    if (!onto) {
      process.exit(0);
    }

    const driftingAxes = getDriftingAxes(onto);
    if (driftingAxes.length < MIN_DRIFTING_AXES) {
      process.exit(0);
    }

    const signals = recentSignals();
    const vocation = loadJson(VOCATION_PATH);

    console.log(`[predictive_prompt] ${driftingAxes.length} axes drifting, generating prediction...`);

    const prediction = await generatePrediction(driftingAxes, signals, vocation);

    if (!prediction || prediction.length < 20) {
      console.log("[predictive_prompt] LLM returned empty/too-short prediction — skipping");
      process.exit(0);
    }

    // Truncate to 280 chars
    const tweet = prediction.length > 280 ? prediction.slice(0, 277) + "..." : prediction;

    // Log the prediction
    const record = {
      ts: new Date().toISOString(),
      axes_count: driftingAxes.length,
      top_axes: driftingAxes.slice(0, 5).map(a => a.label),
      prediction: tweet,
    };
    fs.appendFileSync(PREDICTION_LOG, JSON.stringify(record) + "\n", "utf-8");

    console.log(`[predictive_prompt] prediction: ${tweet}`);

    if (!isDryRun) {
      fs.writeFileSync(PREDICTION_DRAFT, tweet, "utf-8");
      console.log("[predictive_prompt] draft written to state/prediction_draft.txt");
    }

    process.exit(0);
  } catch (e) {
    console.error(`[predictive_prompt] error: ${e.message}`);
    process.exit(0); // non-fatal
  }
})();
