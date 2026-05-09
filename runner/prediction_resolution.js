#!/usr/bin/env node
/**
 * runner/prediction_resolution.js — auto-resolve past-deadline predictions
 *
 * Self-throttled: runs at most once per day via stamp file.
 * For each prediction past its deadline (resolution_status === "pending"),
 * uses ontology context gathered since the prediction was made plus a Gemini
 * assessment to assign: "correct" | "wrong" | "partial" | "expired".
 *
 * Updates prediction_log.jsonl in-place and re-exports prediction_export.json.
 * Optionally writes state/resolution_tweet_draft.txt for the best resolution.
 *
 * Usage:
 *   node runner/prediction_resolution.js
 *   node runner/prediction_resolution.js --dry-run
 */

"use strict";

const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");

const ROOT              = path.resolve(__dirname, "..");
const PREDICTION_LOG    = path.join(ROOT, "state", "prediction_log.jsonl");
const PREDICTION_EXPORT = path.join(ROOT, "state", "prediction_export.json");
const ONTO_PATH         = path.join(ROOT, "state", "ontology.json");
const STAMP_PATH        = path.join(ROOT, "state", ".last_prediction_resolution");
const RESOLUTION_DRAFT  = path.join(ROOT, "state", "resolution_tweet_draft.txt");

const { callVertex } = require("./vertex.js");

const COOLDOWN_MS = 22 * 60 * 60 * 1000; // once per ~day
const isDryRun    = process.argv.includes("--dry-run");

function isOnCooldown() {
  try {
    const mtime = fs.statSync(STAMP_PATH).mtimeMs;
    return Date.now() - mtime < COOLDOWN_MS;
  } catch { return false; }
}

function loadLines() {
  try {
    return fs.readFileSync(PREDICTION_LOG, "utf-8").split("\n").filter(Boolean);
  } catch { return []; }
}

function saveLines(lines) {
  fs.writeFileSync(PREDICTION_LOG, lines.join("\n") + "\n", "utf-8");
}

function loadOntology() {
  try { return JSON.parse(fs.readFileSync(ONTO_PATH, "utf-8")); } catch { return null; }
}

/** Gather evidence that arrived after predTs on the listed axes. */
function gatherAxisContext(onto, topAxes, predTs) {
  if (!onto) return "";
  const predTime = new Date(predTs).getTime();
  const axisMap = {};
  for (const a of (onto.axes || [])) axisMap[a.label] = a;

  const snippets = [];
  for (const label of topAxes) {
    const axis = axisMap[label];
    if (!axis) continue;
    const recent = (axis.evidence_log || [])
      .filter(e => e.ts && new Date(e.ts).getTime() > predTime)
      .slice(-5)
      .map(e => e.content || "")
      .filter(Boolean);
    if (recent.length > 0) {
      snippets.push(`[${label}]: ${recent.join(" | ").slice(0, 400)}`);
    }
  }
  return snippets.join("\n").slice(0, 2000);
}

async function assessPrediction(prediction, context) {
  const prompt = `You are evaluating a prediction made by an AI analyst named Sebastian D. Hunter.

Prediction (made on ${prediction.ts}):
"${prediction.prediction}"

Evidence observed since the prediction was made:
${context || "(no new evidence found in belief axes)"}

Today's date: ${new Date().toISOString().slice(0, 10)}
Deadline was: ${prediction.deadline_at ? prediction.deadline_at.slice(0, 10) : "unknown"}

Based on the evidence, assess whether this prediction came true.

Return ONLY a JSON object on a single line:
{"verdict": "correct"|"wrong"|"partial"|"expired", "note": "1-2 sentence explanation", "tweet": "optional short tweet announcing outcome (max 240 chars, or null if not worth tweeting)"}

Rules:
- "correct": the core claim clearly happened
- "wrong": the opposite happened or the claim was clearly falsified
- "partial": part of it came true, but not fully
- "expired": deadline passed with no clear resolution either way
- The tweet (if non-null) should be in first person, acknowledging the result frankly`;

  const raw = await callVertex(prompt, 400);
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { verdict: "expired", note: "Could not parse assessment.", tweet: null };
  }
}

function rebuildExport() {
  try {
    const raw = fs.existsSync(PREDICTION_LOG)
      ? fs.readFileSync(PREDICTION_LOG, "utf-8").split("\n").filter(Boolean)
      : [];

    const predictions = raw.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).reverse();

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

    fs.writeFileSync(PREDICTION_EXPORT, JSON.stringify({
      generated_at: new Date().toISOString(),
      stats,
      predictions,
    }, null, 2), "utf-8");
  } catch (e) {
    console.error(`[prediction_resolution] rebuild export failed: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async function main() {
  if (isOnCooldown()) {
    process.exit(0);
  }

  const onto = loadOntology();
  const lines = loadLines();
  if (lines.length === 0) {
    process.exit(0);
  }

  const now = Date.now();
  let changed = false;
  let bestResolutionTweet = null;

  const updatedLines = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { updatedLines.push(line); continue; }

    // Only process pending entries past their deadline
    if ((entry.resolution_status || "pending") !== "pending") {
      updatedLines.push(line);
      continue;
    }

    const deadline = entry.deadline_at ? new Date(entry.deadline_at).getTime() : 0;
    if (!deadline || now < deadline) {
      updatedLines.push(line);
      continue;
    }

    console.log(`[prediction_resolution] assessing: "${entry.prediction?.slice(0, 80)}..."`);

    const context = gatherAxisContext(onto, entry.top_axes || [], entry.ts);
    const assessment = await assessPrediction(entry, context);

    entry.resolution_status = assessment.verdict || "expired";
    entry.resolved_at = new Date().toISOString();
    entry.resolution_note = assessment.note || null;
    changed = true;

    if (assessment.tweet && !bestResolutionTweet) {
      bestResolutionTweet = assessment.tweet;
    }

    console.log(`[prediction_resolution] verdict: ${entry.resolution_status} — ${entry.resolution_note}`);
    updatedLines.push(JSON.stringify(entry));
  }

  if (!changed) {
    // Touch stamp even if no predictions to resolve — avoids re-checking every cycle
    if (!isDryRun) fs.writeFileSync(STAMP_PATH, new Date().toISOString(), "utf-8");
    process.exit(0);
  }

  if (!isDryRun) {
    saveLines(updatedLines);
    rebuildExport();

    if (bestResolutionTweet) {
      fs.writeFileSync(RESOLUTION_DRAFT, bestResolutionTweet, "utf-8");
      console.log("[prediction_resolution] resolution tweet draft written");
    }

    fs.writeFileSync(STAMP_PATH, new Date().toISOString(), "utf-8");

    try {
      execSync(
        `git add "${PREDICTION_LOG}" "${PREDICTION_EXPORT}" && git commit -m "predictions: resolve expired predictions" || true`,
        { cwd: ROOT, stdio: "ignore" }
      );
      execSync("git push", { cwd: ROOT, stdio: "ignore" });
    } catch (e) {
      console.error(`[prediction_resolution] git push failed: ${e.message}`);
    }
  }

  process.exit(0);
})().catch(e => {
  console.error(`[prediction_resolution] fatal: ${e.message}`);
  process.exit(0);
});
