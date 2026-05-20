#!/usr/bin/env node
// runner/reflect.js — daily reflection pass (no browser, no function-calling)
//
// Input:  last 7 days of journal entries from SQLite + current ontology.json
// Output: appends a dated entry to state/reflection_notes.md
//
// Called from run.sh daily maintenance block.

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { loadScraperDb } = require("./lib/db_backend");
const db = loadScraperDb();

// ── Load env ───────────────────────────────────────────────────────────────────
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const REFLECTION_NOTES = path.join(ROOT, "state", "reflection_notes.md");
const ONTOLOGY_PATH    = path.join(ROOT, "state", "ontology.json");

const { callVertex } = require("./vertex.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatAxes() {
  try {
    const o = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, "utf-8"));
    const axes = (o.axes || [])
      .filter(a => (a.confidence || 0) >= 0.3 && Math.abs(a.score || 0) > 0.05)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 10);
    if (!axes.length) return "(no axes yet)";
    return axes.map(a => {
      const dir = (a.score || 0) > 0 ? a.right_pole || "RIGHT"
                                      : a.left_pole  || "LEFT";
      const mag = Math.abs(a.score || 0).toFixed(2);
      const conf = ((a.confidence || 0) * 100).toFixed(0);
      return `  [${a.id}] ${a.label} → ${dir} (score:${mag}, conf:${conf}%, ev:${(a.evidence_log||[]).length})`;
    }).join("\n");
  } catch { return "(could not read ontology)"; }
}

function lastReflectionSnippet() {
  try {
    if (!fs.existsSync(REFLECTION_NOTES)) return "";
    const lines = fs.readFileSync(REFLECTION_NOTES, "utf-8").split("\n");
    return lines.slice(-30).join("\n").trim();
  } catch { return ""; }
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[reflect] starting daily reflection...");

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Pull journals from last 7 days
  const allJournals = await db.recentMemory("journal", 28);
  const journals = allJournals.filter(j => j.date >= cutoff);

  if (journals.length === 0) {
    console.log("[reflect] no journals from last 7 days — skipping");
    process.exit(0);
  }

  // Sort oldest-first so the narrative flows chronologically
  journals.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.hour || 0) - (b.hour || 0));

  console.log(`[reflect] ${journals.length} journal entries from ${cutoff} to ${today}`);

  const journalBlock = journals.map(j =>
    `[${j.date} h${String(j.hour ?? "?").padStart(2, "0")}]\n${j.text_content.slice(0, 1500).trim()}`
  ).join("\n\n---\n\n");

  const axesBlock = formatAxes();
  const priorReflection = lastReflectionSnippet();

  const prompt = `You are Sebastian D. Hunter — an autonomous agent who has been watching X/Twitter and forming beliefs through observation. The date is ${today}.

Below are your journal synthesis narratives from the last 7 days. These are your own words from section 1 of each journal — interpretive, not raw notes.

JOURNAL ENTRIES (chronological):
${journalBlock}

CURRENT BELIEF AXES (your live ontology — read before reflecting):
${axesBlock}
${priorReflection ? `\nYOUR MOST RECENT PRIOR REFLECTION (for continuity):\n${priorReflection}\n` : ""}
---
Task: Write a ~150-word reflection. No browsing, no research — this is internal synthesis only.
Write in first person. Be honest and critical. Do not summarise — reflect.

Cover all four of these, concisely:
1. PATTERN: What cross-cycle pattern only becomes visible looking across the full week? Not a daily observation — a structural pattern.
2. SHIFTED: Which belief axis moved most, and what specifically drove that shift?
3. UNRESOLVED: What remains open — a claim you made that you cannot yet verify, or a tension between axes you have not synthesised?
4. WRONG: Where were you hasty or wrong? Name it specifically.

Format as prose, not a list. ~150 words. Do not add headers or labels.`;

  let reflection;
  try {
    reflection = await callVertex(prompt, 512, { thinkingBudget: 512 });
  } catch (e) {
    console.error("[reflect] Vertex call failed:", e.message);
    process.exit(0);
  }

  const entry = `\n## Reflection: ${today}\n\n${reflection.trim()}\n`;

  try {
    fs.appendFileSync(REFLECTION_NOTES, entry, "utf-8");
    console.log(`[reflect] appended reflection for ${today} (${reflection.length} chars)`);
  } catch (e) {
    console.error("[reflect] failed to write reflection_notes.md:", e.message);
  }

  process.exit(0);
})();
