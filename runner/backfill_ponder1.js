#!/usr/bin/env node
/**
 * runner/backfill_ponder1.js — one-shot: write ponders/ponder_1.md from existing state
 *
 * Run once: node runner/backfill_ponder1.js
 * Safe to run multiple times — will not overwrite if ponder_1.md already exists.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..");
const STATE       = path.join(ROOT, "state");
const PONDERS_DIR = path.join(ROOT, "ponders");

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

const ponderState = loadJson(path.join(STATE, "ponder_state.json")) || {};
const vocation    = loadJson(path.join(STATE, "vocation.json")) || {};
const plans       = loadJson(path.join(STATE, "action_plans.json")) || [];

const date            = ponderState.last_ponder_date || new Date().toISOString().slice(0, 10);
const ponderCount     = 1;
const vocStatement    = vocation.statement || "";
const axesTriggered   = vocation.hardened_axes || [];

// Use plans created on the ponder date (or all proposed plans as fallback)
const ponderPlans = plans.filter(p => p.created === date || p.status === "proposed");

if (ponderPlans.length === 0) {
  console.error("[backfill] no plans found for ponder date — check action_plans.json");
  process.exit(1);
}

// Axis context from ponder_state snapshots
const snapshots = ponderState.axis_snapshots || {};
const axisLines = axesTriggered
  .filter(id => snapshots[id])
  .map(id => {
    const s = snapshots[id];
    const dir = (s.score || 0) > 0 ? "leans positive" : "leans negative";
    return `- **${id}**: confidence=${((s.confidence || 0) * 100).toFixed(0)}%, score=${(s.score || 0).toFixed(3)} (${dir})`;
  })
  .join("\n") || "- (axis details not available)";

const planSections = ponderPlans.map((p, i) => {
  return `### ${i + 1}. ${p.title}

**Type:** ${p.action_type}

**What drives this:** ${p.compulsion}

**What I would do:** ${p.brief}

**Success in 30 days:** ${p.success_30d}`;
}).join("\n\n---\n\n");

const ponderMd = `---
date: "${date}"
title: "Ponder ${ponderCount} — ${date}"
ponder: ${ponderCount}
vocation: "${vocStatement.replace(/"/g, "'")}"
axes_triggered: [${axesTriggered.map(a => `"${a}"`).join(", ")}]
moltbook: ""
---

# Ponder ${ponderCount} — ${date}

**Vocation:** ${vocStatement}

---

## Triggering convictions

These belief axes reached conviction threshold (confidence ≥ 0.72, |score| ≥ 0.15) with sufficient shift since the last ponder:

${axisLines}

---

## Action proposals

${planSections}

---

*This ponder was backfilled by backfill_ponder1.js from state captured on ${date}.*
`;

if (!fs.existsSync(PONDERS_DIR)) fs.mkdirSync(PONDERS_DIR, { recursive: true });

const ponderPath = path.join(PONDERS_DIR, `ponder_${ponderCount}.md`);
const latestPath = path.join(PONDERS_DIR, "latest.md");

if (fs.existsSync(ponderPath)) {
  console.log(`[backfill] ponder_${ponderCount}.md already exists — skipping (delete it first to re-backfill)`);
  process.exit(0);
}

fs.writeFileSync(ponderPath, ponderMd, "utf-8");
fs.writeFileSync(latestPath, ponderMd, "utf-8");
console.log(`[backfill] written: ponders/ponder_${ponderCount}.md + latest.md`);

// Update ponder_state.json with ponder_count so future ponders increment correctly
if (!ponderState.ponder_count) {
  ponderState.ponder_count = ponderCount;
  fs.writeFileSync(path.join(STATE, "ponder_state.json"), JSON.stringify(ponderState, null, 2));
  console.log(`[backfill] ponder_state.json updated: ponder_count=${ponderCount}`);
}

console.log("[backfill] done");
console.log("");
console.log("Next step: run --post-ponder to send it to Moltbook:");
console.log("  touch state/ponder_post_pending && node runner/moltbook.js --post-ponder");
