#!/usr/bin/env node
/**
 * runner/predictive_prompt.js — generate a prediction tweet from observed patterns
 *
 * Reads ontology axes with recent drift, evidence logs, and signal history
 * to produce a short prediction about what may happen next.
 *
 * Cooldown: max 1 prediction per 24h.
 * Called by post_browse.js after signal_detector, every browse cycle.
 * Non-fatal: exits 0 on any error.
 *
 * Writes state/prediction_draft.txt if a prediction is warranted.
 * Appends a structured entry to state/prediction_log.jsonl.
 * Writes state/prediction_export.json and commits+pushes.
 *
 * Usage:
 *   node runner/predictive_prompt.js
 *   node runner/predictive_prompt.js --dry-run
 */

"use strict";

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");
const crypto        = require("crypto");

const ROOT              = path.resolve(__dirname, "..");
const ONTO_PATH         = path.join(ROOT, "state", "ontology.json");
const DRIFT_ALERTS_PATH = path.join(ROOT, "state", "drift_alerts.jsonl");
const SIGNAL_LOG_PATH   = path.join(ROOT, "state", "signal_log.jsonl");
const PREDICTION_LOG    = path.join(ROOT, "state", "prediction_log.jsonl");
const PREDICTION_DRAFT  = path.join(ROOT, "state", "prediction_draft.txt");
const PREDICTION_EXPORT = path.join(ROOT, "state", "prediction_export.json");
const VOCATION_PATH     = path.join(ROOT, "state", "vocation.json");

const { callVertex } = require("./vertex.js");

// ── Configuration ─────────────────────────────────────────────────────────────
const COOLDOWN_HOURS    = 24;
const MIN_DRIFTING_AXES = 3;
const LOOKBACK_HOURS    = 48;
const RESOLUTION_DAYS   = 30;

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

function getDriftingAxes(onto) {
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const driftMap = new Map();

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

function recentBrowseContext() {
  const notesPath = path.join(ROOT, "state", "browse_notes.md");
  try {
    const raw = fs.readFileSync(notesPath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("[NOTED]"));
    return lines.slice(-60).join("\n").slice(0, 2000);
  } catch { return ""; }
}

async function generatePrediction(driftingAxes, vocation) {
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
- Sound like a watchdog analyst citing observed patterns, not a pundit
- Do NOT say "my axes", "belief drift", "correlated axes", "axis", or any internal system language
- Do NOT use hashtags or emojis
- Write in first person

Also estimate your confidence in this prediction from 1–100.

Return ONLY a JSON object on a single line, like this:
{"tweet": "your prediction here", "confidence_pct": 72}`;

  const raw = await callVertex(prompt, 600);

  // Extract JSON from response — strip any markdown fences
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.tweet && typeof parsed.confidence_pct === "number") {
      return { tweet: parsed.tweet.trim(), confidence_pct: Math.max(1, Math.min(100, Math.round(parsed.confidence_pct))) };
    }
  } catch {}

  // Fallback: if LLM returned plain text (old behavior), treat as tweet with unknown confidence
  if (cleaned.length > 20 && !cleaned.startsWith("{")) {
    return { tweet: cleaned.replace(/^["']|["']$/g, ""), confidence_pct: null };
  }
  return null;
}

function exportAndPush() {
  try {
    const raw = fs.existsSync(PREDICTION_LOG)
      ? fs.readFileSync(PREDICTION_LOG, "utf-8").split("\n").filter(Boolean)
      : [];

    const predictions = raw.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).reverse(); // newest first

    const stats = { total: 0, correct: 0, wrong: 0, partial: 0, pending: 0, expired: 0 };
    for (const p of predictions) {
      stats.total++;
      const status = p.resolution_status || "pending";
      if (status === "correct") stats.correct++;
      else if (status === "wrong") stats.wrong++;
      else if (status === "partial") stats.partial++;
      else if (status === "expired") stats.expired++;
      else stats.pending++;
    }
    const resolved = stats.correct + stats.wrong + stats.partial;
    stats.accuracy = resolved > 0 ? Math.round((stats.correct / resolved) * 100) : null;

    const exported = {
      generated_at: new Date().toISOString(),
      stats,
      predictions,
    };

    fs.writeFileSync(PREDICTION_EXPORT, JSON.stringify(exported, null, 2), "utf-8");
    console.log(`[predictive_prompt] exported ${predictions.length} predictions`);

    execSync(
      `git add "${PREDICTION_LOG}" "${PREDICTION_EXPORT}" && git commit -m "predictions: update log + export" || true`,
      { cwd: ROOT, stdio: "ignore" }
    );
    execSync("git push", { cwd: ROOT, stdio: "ignore" });
  } catch (e) {
    console.error(`[predictive_prompt] exportAndPush failed: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

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

    const vocation = loadJson(VOCATION_PATH);

    console.log(`[predictive_prompt] ${driftingAxes.length} axes drifting, generating prediction...`);

    const result = await generatePrediction(driftingAxes, vocation);

    if (!result || !result.tweet || result.tweet.length < 20) {
      console.log("[predictive_prompt] LLM returned empty/too-short prediction — skipping");
      process.exit(0);
    }

    const tweet = result.tweet.length > 280 ? result.tweet.slice(0, 277) + "..." : result.tweet;
    const deadline = new Date(Date.now() + RESOLUTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const record = {
      id: "pred_" + crypto.randomBytes(4).toString("hex"),
      ts: new Date().toISOString(),
      axes_count: driftingAxes.length,
      top_axes: driftingAxes.slice(0, 5).map(a => a.label),
      prediction: tweet,
      confidence_pct: result.confidence_pct,
      resolution_status: "pending",
      deadline_at: deadline,
      resolved_at: null,
      resolution_note: null,
      tweet_url: null,
    };

    fs.appendFileSync(PREDICTION_LOG, JSON.stringify(record) + "\n", "utf-8");
    console.log(`[predictive_prompt] prediction (${result.confidence_pct ?? "?"}% confidence): ${tweet}`);

    if (!isDryRun) {
      fs.writeFileSync(PREDICTION_DRAFT, tweet, "utf-8");
      console.log("[predictive_prompt] draft written to state/prediction_draft.txt");
      exportAndPush();
    }

    process.exit(0);
  } catch (e) {
    console.error(`[predictive_prompt] error: ${e.message}`);
    process.exit(0);
  }
})();
