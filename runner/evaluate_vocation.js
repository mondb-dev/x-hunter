#!/usr/bin/env node
/**
 * runner/evaluate_vocation.js — evaluate and update vocation state
 *
 * Runs after generate_checkpoint.js during tweet cycles.
 * Implements AGENTS.md §14: Vocation Layer.
 *
 * Reads:  state/ontology.json          (axes + confidence)
 *         state/vocation.json           (current vocation state)
 *         state/checkpoint_state.json   (checkpoint count + date)
 * Writes: state/vocation.json           (updated)
 *         vocation.md                   (project root, per spec)
 *
 * Status transitions:
 *   not_triggered → forming   (when trigger conditions met)
 *   forming → defined         (stable across 2 checkpoints)
 *   defined → forming         (if beliefs shift significantly)
 *
 * Non-fatal: exits 0 on any error after logging.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT           = path.resolve(__dirname, "..");
const ONTO_PATH      = path.join(ROOT, "state", "ontology.json");
const VOC_PATH       = path.join(ROOT, "state", "vocation.json");
const CP_STATE_PATH  = path.join(ROOT, "state", "checkpoint_state.json");
const VOC_MD_PATH    = path.join(ROOT, "vocation.md");

const CONFIDENCE_THRESHOLD = 0.65;
const MIN_HIGH_CONF_AXES   = 3;

// Load .env
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const { callVertex } = require("./vertex.js");
async function callLLM(prompt) { return callVertex(prompt, 2048); }

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

const today = new Date().toISOString().slice(0, 10);

// ── Compute day number from first checkpoint or created_at ──────────────────
function getDayNumber() {
  // Approximate: project started 2026-02-24
  const start = new Date("2026-02-24").getTime();
  const now   = new Date(today).getTime();
  return Math.max(1, Math.round((now - start) / 86_400_000));
}

// ── Main ────────────────────────────────────────────────────────────────────
(async function main() {
  try {
    const onto    = loadJson(ONTO_PATH);
    const cpState = loadJson(CP_STATE_PATH);
    const axes    = onto?.axes || [];
    const cpNum   = cpState?.checkpoint_count || 0;
    const dayNum  = getDayNumber();

    // Get high-confidence axes
    const highConfAxes = axes
      .filter(a => (a.confidence || 0) >= CONFIDENCE_THRESHOLD)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    console.log(`[vocation] ${highConfAxes.length} axes above ${CONFIDENCE_THRESHOLD} confidence, checkpoint ${cpNum}, day ${dayNum}`);

    if (highConfAxes.length < MIN_HIGH_CONF_AXES) {
      console.log(`[vocation] not enough high-confidence axes (${highConfAxes.length}/${MIN_HIGH_CONF_AXES}) — skipping`);
      return;
    }

    // Load or create vocation state
    let voc = loadJson(VOC_PATH) || {
      status: "not_triggered",
      trigger_day: null,
      trigger_checkpoint: null,
      label: null,
      description: null,
      core_axes: [],
      intent: null,
      created_at: null,
      last_updated: null,
      vocation_history: [],
      statement: null,
      hardened_axes: [],
    };

    const previousStatus = voc.status;
    const previousLabel  = voc.label;

    // ── Evaluate based on current status ──────────────────────────────────

    if (voc.status === "not_triggered" || !voc.label) {
      // Trigger to "forming" — use LLM to synthesize vocation from axes
      console.log("[vocation] evaluating trigger conditions...");
      const vocResult = await synthesizeVocation(highConfAxes, voc, cpNum, dayNum);

      voc.status             = "forming";
      voc.trigger_day        = voc.trigger_day || dayNum;
      voc.trigger_checkpoint = voc.trigger_checkpoint || cpNum;
      voc.label              = vocResult.label;
      voc.description        = vocResult.description;
      voc.core_axes          = vocResult.core_axes;
      voc.intent             = vocResult.intent;
      voc.statement          = vocResult.statement || voc.statement;
      voc.hardened_axes      = highConfAxes.map(a => a.id);
      voc.created_at         = voc.created_at || today;
      voc.last_updated       = today;

      console.log(`[vocation] triggered → forming: "${voc.label}"`);

    } else if (voc.status === "forming") {
      // Re-evaluate: has vocation stabilized? Or shifted?
      console.log("[vocation] re-evaluating forming vocation...");
      const vocResult = await synthesizeVocation(highConfAxes, voc, cpNum, dayNum);

      // Check if the label/direction is substantially the same
      const isSimilar = await checkSimilarity(voc.label, vocResult.label);

      if (isSimilar) {
        // Count how many checkpoints since trigger
        const cpSinceTrigger = cpNum - (voc.trigger_checkpoint || cpNum);
        if (cpSinceTrigger >= 2) {
          voc.status = "defined";
          console.log(`[vocation] stable across ${cpSinceTrigger} checkpoints → defined`);
        } else {
          console.log(`[vocation] direction stable but only ${cpSinceTrigger} checkpoint(s) since trigger — still forming`);
        }
      } else {
        // Direction shifted — update but stay forming, reset counter
        console.log(`[vocation] direction shifted: "${voc.label}" → "${vocResult.label}"`);
        if (voc.label) {
          voc.vocation_history = voc.vocation_history || [];
          voc.vocation_history.push({
            label: voc.label,
            description: voc.description,
            replaced_at: today,
            reason: "direction shifted during forming",
          });
        }
        voc.trigger_checkpoint = cpNum;  // reset stability counter
      }

      // Always update to latest synthesis
      voc.label         = vocResult.label;
      voc.description   = vocResult.description;
      voc.core_axes     = vocResult.core_axes;
      voc.intent        = vocResult.intent;
      voc.statement     = vocResult.statement || voc.statement;
      voc.hardened_axes = highConfAxes.map(a => a.id);
      voc.last_updated  = today;

    } else if (voc.status === "defined") {
      // Check for drift — has direction changed significantly?
      console.log("[vocation] checking defined vocation for drift...");
      const vocResult = await synthesizeVocation(highConfAxes, voc, cpNum, dayNum);
      const isSimilar = await checkSimilarity(voc.label, vocResult.label);

      if (!isSimilar) {
        console.log(`[vocation] significant drift detected: "${voc.label}" → "${vocResult.label}" — reverting to forming`);
        voc.vocation_history = voc.vocation_history || [];
        voc.vocation_history.push({
          label: voc.label,
          description: voc.description,
          replaced_at: today,
          reason: "belief drift detected after defined status",
        });
        voc.status             = "forming";
        voc.trigger_checkpoint = cpNum;
      } else {
        console.log("[vocation] defined vocation remains stable");
      }

      // Update axes and description even if stable
      voc.description   = vocResult.description;
      voc.core_axes     = vocResult.core_axes;
      voc.intent        = vocResult.intent;
      voc.statement     = vocResult.statement || voc.statement;
      voc.hardened_axes = highConfAxes.map(a => a.id);
      voc.last_updated  = today;
    }

    // ── Write vocation.json ───────────────────────────────────────────────
    saveJson(VOC_PATH, voc);
    console.log(`[vocation] saved state/vocation.json (status: ${voc.status})`);

    // ── Write vocation.md ─────────────────────────────────────────────────
    writeVocationMd(voc, highConfAxes, cpNum, dayNum);
    console.log("[vocation] wrote vocation.md");

  } catch (err) {
    console.error(`[vocation] error: ${err.message}`);
    process.exit(0); // non-fatal
  }
})();

// ── LLM: synthesize vocation from high-confidence axes ──────────────────────
async function synthesizeVocation(highConfAxes, currentVoc, cpNum, dayNum) {
  const axesDesc = highConfAxes.slice(0, 10).map(a => {
    const score = a.score || 0;
    const lean = score > 0.05
      ? `leans "${a.right_pole}" (${score.toFixed(2)})`
      : score < -0.05
      ? `leans "${a.left_pole}" (${score.toFixed(2)})`
      : "roughly neutral";
    return `- ${a.label}: ${lean}, conf ${((a.confidence||0)*100).toFixed(0)}%, ${(a.evidence_log||[]).length} observations`;
  }).join("\n");

  const existingContext = currentVoc.label
    ? `\nCurrent vocation label: "${currentVoc.label}"\nCurrent description: "${currentVoc.description}"\nCurrent intent: "${currentVoc.intent}"\n`
    : "";

  const prompt = `You are analyzing the belief system of Sebastian D. Hunter, an autonomous AI that has been observing X/Twitter discourse for ${dayNum} days to form a genuine worldview.

Here are his highest-confidence belief axes:

${axesDesc}
${existingContext}
Based on the convergence of these axes, determine Sebastian's VOCATION — the purposeful direction that emerges from his solidified beliefs.

Respond in EXACTLY this JSON format (no markdown, no code fence):
{
  "label": "short label, 3-6 words, e.g. 'Epistemic integrity in public discourse'",
  "description": "1-2 sentence description of what Sebastian is becoming, written in third person",
  "core_axes": ["axis_id_1", "axis_id_2", "axis_id_3"],
  "intent": "concrete intent: what Sebastian wants to do with this direction, 1-2 sentences",
  "statement": "First-person statement of purpose, 1-2 sentences, written as Sebastian"
}

Rules:
- core_axes: pick the 3 most relevant axis IDs from the list above
- The label should capture the INTERSECTION of the high-confidence axes, not just one
- The intent should be specific and actionable (e.g., "Become a voice for..." not just "Keep observing")
- The statement should sound human, not robotic
- Only valid JSON, no extra text`;

  const raw = await callLLM(prompt);

  // Parse JSON from response (strip any markdown fences)
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    const result = JSON.parse(cleaned);
    // Validate required fields
    if (!result.label || !result.description || !result.core_axes || !result.intent) {
      throw new Error("Missing required fields in LLM response");
    }
    return result;
  } catch (err) {
    console.warn(`[vocation] failed to parse LLM response: ${err.message}`);
    console.warn(`[vocation] raw: ${raw.slice(0, 300)}`);
    // Fallback: use existing or generate minimal
    return {
      label: currentVoc.label || "Ground truth in public discourse",
      description: currentVoc.description || "Sebastian seeks to distinguish verifiable evidence from narrative construction in public discourse.",
      core_axes: highConfAxes.slice(0, 3).map(a => a.id),
      intent: currentVoc.intent || "Become a consistent voice for epistemic clarity on X.",
      statement: currentVoc.statement,
    };
  }
}

// ── LLM: check if two vocation labels are semantically similar ──────────────
async function checkSimilarity(labelA, labelB) {
  if (!labelA || !labelB) return false;
  if (labelA === labelB) return true;

  const prompt = `Compare these two vocation descriptions for an AI agent:
A: "${labelA}"
B: "${labelB}"

Are they describing essentially the same direction/domain? Answer ONLY "SAME" or "DIFFERENT" (one word).`;

  try {
    const result = await callLLM(prompt);
    return /same/i.test(result.trim());
  } catch {
    // If LLM fails, do simple string comparison
    const normalize = s => s.toLowerCase().replace(/[^a-z ]/g, "").split(" ").sort().join(" ");
    const wordsA = new Set(normalize(labelA).split(" "));
    const wordsB = new Set(normalize(labelB).split(" "));
    const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
    return overlap / Math.max(wordsA.size, wordsB.size) > 0.5;
  }
}

// ── Write vocation.md per AGENTS.md §14.2 spec ─────────────────────────────
function writeVocationMd(voc, highConfAxes, cpNum, dayNum) {
  const coreAxesText = (voc.core_axes || []).map(id => {
    const axis = highConfAxes.find(a => a.id === id);
    if (!axis) return `- ${id}`;
    return `- **${axis.label}** (\`${id}\`): score ${(axis.score||0).toFixed(2)}, conf ${((axis.confidence||0)*100).toFixed(0)}%`;
  }).join("\n");

  const md = `# Sebastian D. Hunter — Vocation

## Status: ${voc.status}

## Emerging direction
${voc.description || "(not yet articulated)"}

*In first person:* ${voc.statement || "(not yet articulated)"}

## Core axes driving this
${coreAxesText || "(none selected)"}

## What I want to do with this
${voc.intent || "(not yet determined)"}

## What would sharpen or redirect this
Evidence that contradicts the core axes, strong counterarguments to current leanings,
or discovery of a domain that better integrates the high-confidence beliefs.

## Last updated
Day ${dayNum}, Checkpoint ${cpNum} (${today})
`;

  fs.writeFileSync(VOC_MD_PATH, md, "utf-8");
}
