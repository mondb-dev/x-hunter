#!/usr/bin/env node
/**
 * runner/curiosity.js — curiosity seed generator with local LLM selection
 *
 * Queries top keywords from the last 4h of scraped posts, then uses a local
 * Ollama model (qwen2.5:7b) to pick the single most relevant keyword based on
 * the agent's current ontology axes and browse notes.
 *
 * Writes state/curiosity_seeds.txt with the chosen keyword + search URL,
 * so the browse agent just executes rather than decides.
 *
 * Usage: node runner/curiosity.js
 * Called by run.sh every 4th BROWSE cycle.
 * Falls back to top keyword by frequency if Ollama is unavailable.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("../scraper/db");

const ROOT        = path.resolve(__dirname, "..");
const OUT         = path.join(ROOT, "state", "curiosity_seeds.txt");
const ONTOLOGY    = path.join(ROOT, "state", "ontology.json");
const BELIEF      = path.join(ROOT, "state", "belief_state.json");
const BROWSE_NOTES = path.join(ROOT, "state", "browse_notes.md");

const OLLAMA_URL   = process.env.OLLAMA_URL  || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

// ── Context readers ───────────────────────────────────────────────────────────

function getAxes() {
  if (!fs.existsSync(ONTOLOGY)) return "(no axes yet)";
  try {
    const data = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
    return (data.axes || []).slice(0, 6)
      .map(a => `- ${a.label}: ${a.left_pole} <-> ${a.right_pole}`)
      .join("\n") || "(no axes yet)";
  } catch { return "(no axes yet)"; }
}

function getBeliefSummary() {
  if (!fs.existsSync(BELIEF)) return "";
  try {
    const data = JSON.parse(fs.readFileSync(BELIEF, "utf-8"));
    const active = (data.active_axes || []).slice(0, 3).join(", ");
    const watch  = (data.watch_list  || []).slice(0, 3).join(", ");
    const parts  = [];
    if (active) parts.push(`Active axes: ${active}`);
    if (watch)  parts.push(`Watching: ${watch}`);
    return parts.join(" | ");
  } catch { return ""; }
}

function getBrowseNotesSummary() {
  if (!fs.existsSync(BROWSE_NOTES)) return "";
  const text = fs.readFileSync(BROWSE_NOTES, "utf-8").trim();
  if (!text) return "";
  // Just the first 400 chars — enough for the LLM to get context
  return text.slice(0, 400).replace(/\s+/g, " ");
}

// ── Ollama call ───────────────────────────────────────────────────────────────

async function callOllama(prompt) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        model:   OLLAMA_MODEL,
        prompt,
        stream:  false,
        options: { temperature: 0.1, num_predict: 60 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.response || "").trim();
  } catch (err) {
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const top = db.topKeywords(4, 20).slice(0, 5);

  if (!top || top.length === 0) {
    console.log("[curiosity] no keywords found in last 4h — skipping");
    process.exit(0);
  }

  const ts    = new Date().toISOString().replace("T", " ").slice(0, 16);
  const axes  = getAxes();
  const brief = getBeliefSummary();
  const notes = getBrowseNotesSummary();

  // Format candidate list for the LLM
  const candidateList = top
    .map((kw, i) => `${i + 1}. "${kw.keyword}" (${kw.count} posts, avg score ${kw.avg_score?.toFixed(1) ?? "?"}`)
    .join("\n");

  const prompt =
`You are helping a political-commentary AI agent decide what to search on X (Twitter).

Agent ontology axes:
${axes}
${brief ? `\n${brief}` : ""}
${notes ? `\nCurrent browse notes (excerpt): "${notes}"` : ""}

Top scraped keywords from the last 4 hours:
${candidateList}

Which single keyword is MOST worth searching beyond what the digest already shows?
Prefer keywords that connect to the agent's axes, reveal tension, or are genuinely novel.
Reply with ONLY the number (1-${top.length}) of your choice. Nothing else.`;

  let chosen = top[0]; // default: top by frequency
  let chosenIdx = 0;
  let pickedByLLM = false;

  try {
    const raw = await callOllama(prompt);
    // Parse just the digit — LLM instructed to reply with only a number
    const m = raw.match(/\b([1-5])\b/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < top.length) {
        chosenIdx  = idx;
        chosen     = top[idx];
        pickedByLLM = true;
      } else {
        console.log(`[curiosity] LLM returned out-of-range index (${m[1]}) — using top keyword`);
      }
    } else {
      console.log(`[curiosity] LLM response unparseable ("${raw.slice(0, 40)}") — using top keyword`);
    }
    if (pickedByLLM) {
      console.log(`[curiosity] LLM picked #${chosenIdx + 1}: "${chosen.keyword}"`);
    }
  } catch (err) {
    console.log(`[curiosity] Ollama unavailable (${err.message}) — using top keyword`);
  }

  const searchUrl = `https://x.com/search?q=${encodeURIComponent(chosen.keyword)}&f=live`;
  const HR        = "─".repeat(70);

  const lines = [
    `── curiosity · ${ts} ${HR.slice(ts.length + 14)}`,
    `Keyword: "${chosen.keyword}"  (${chosen.count} posts, avg score ${chosen.avg_score?.toFixed(1) ?? "?"})`,
    `Search:  ${searchUrl}`,
    "",
    `Navigate to the Search URL above. Read the top 3 posts. Note anything genuinely`,
    `novel (not already in the digest or browse_notes) to state/browse_notes.md.`,
    `── end curiosity ${HR.slice(18)}`,
  ];

  const stateDir = path.join(ROOT, "state");
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(OUT, lines.join("\n"), "utf-8");
  console.log(`[curiosity] wrote curiosity_seeds.txt → "${chosen.keyword}"`);

  process.exit(0);
})().catch(err => {
  console.error(`[curiosity] fatal: ${err.message}`);
  process.exit(1);
});
