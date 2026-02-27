#!/usr/bin/env node
/**
 * runner/curiosity.js — epistemic curiosity directive generator
 *
 * Driver priority (highest first):
 *   1. discourse  — someone provided substantive counter-reasoning in a reply exchange
 *   2. uncertainty_axis — a belief axis has partial evidence but low confidence
 *   3. trending   — local Ollama picks the most interesting keyword from top 5 scraped
 *
 * Writes state/curiosity_directive.txt — a persistent research focus read by
 * every browse cycle for ~12 cycles (~4h). Also appends one line to
 * state/curiosity_log.jsonl for later analysis of curiosity decision behavior.
 *
 * Usage: node runner/curiosity.js
 * Called by run.sh every 12th BROWSE cycle (CURIOSITY_EVERY=12).
 * Env: CURIOSITY_CYCLE=<n>  CURIOSITY_EVERY=<n>
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("../scraper/db");

const ROOT         = path.resolve(__dirname, "..");
const DIRECTIVE    = path.join(ROOT, "state", "curiosity_directive.txt");
const LOG          = path.join(ROOT, "state", "curiosity_log.jsonl");
const ONTOLOGY     = path.join(ROOT, "state", "ontology.json");
const BELIEF       = path.join(ROOT, "state", "belief_state.json");
const BROWSE_NOTES = path.join(ROOT, "state", "browse_notes.md");
const ANCHORS      = path.join(ROOT, "state", "discourse_anchors.jsonl");

const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

// Env vars passed by run.sh so curiosity.js can compute directive expiry
const CURRENT_CYCLE  = parseInt(process.env.CURIOSITY_CYCLE  || "0",  10);
const CURIOSITY_EVERY = parseInt(process.env.CURIOSITY_EVERY || "12", 10);
const EXPIRES_CYCLE  = CURRENT_CYCLE + CURIOSITY_EVERY;

// Uncertainty thresholds — axis must have started forming but not settled
const UNCERTAINTY_CONFIDENCE_MAX = 0.35;
const UNCERTAINTY_EVIDENCE_MIN   = 2;

// ── Ontology readers ──────────────────────────────────────────────────────────

function getUncertainAxes() {
  if (!fs.existsSync(ONTOLOGY)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
    return (data.axes || [])
      .filter(a =>
        (a.confidence || 0) < UNCERTAINTY_CONFIDENCE_MAX &&
        (a.evidence_log || []).length >= UNCERTAINTY_EVIDENCE_MIN
      )
      .sort((a, b) => (a.confidence || 0) - (b.confidence || 0)); // least confident first
  } catch { return []; }
}

function getAllAxes() {
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
  return text.slice(0, 400).replace(/\s+/g, " ");
}

// ── Ollama (trending fallback) ─────────────────────────────────────────────────

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
  } finally {
    clearTimeout(timeout);
  }
}

// ── Slug helper (for ambient focus tag) ───────────────────────────────────────

function toSlug(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

// ── Log ───────────────────────────────────────────────────────────────────────

function appendLog(entry) {
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(LOG, line, "utf-8");
}

// ── Discourse anchor reader ───────────────────────────────────────────────────

function getUnprocessedDiscourseAnchor() {
  if (!fs.existsSync(ANCHORS)) return null;
  const lines = fs.readFileSync(ANCHORS, "utf-8")
    .split("\n")
    .filter(l => l.trim());

  const processedIds = new Set();
  const anchors      = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.processed_at && entry.post_id) {
        processedIds.add(entry.post_id);
      } else if (entry.post_id && entry.summary) {
        anchors.push(entry);
      }
    } catch { /* skip malformed lines */ }
  }

  // Return most recent unprocessed anchor (anchors are appended chronologically)
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (!processedIds.has(anchors[i].post_id)) return anchors[i];
  }
  return null;
}

function markAnchorProcessed(postId) {
  const marker = JSON.stringify({ post_id: postId, processed_at: new Date().toISOString() });
  fs.appendFileSync(ANCHORS, marker + "\n", "utf-8");
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const ts       = new Date().toISOString();
  const tsHuman  = ts.replace("T", " ").slice(0, 16);
  const HR       = "─".repeat(70);
  const stateDir = path.join(ROOT, "state");
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  // ── Path 1: discourse-triggered — someone challenged Hunter's thinking ───────
  const discourseAnchor = getUnprocessedDiscourseAnchor();

  if (discourseAnchor) {
    const searchTerms = (discourseAnchor.topic || discourseAnchor.summary.split(" ").slice(0, 3).join(" "));
    const searchUrl   = `https://x.com/search?q=${encodeURIComponent(searchTerms)}&f=live`;
    const topicSlug   = toSlug(discourseAnchor.topic || searchTerms);
    const expireLine  = CURRENT_CYCLE > 0
      ? `refreshes at cycle ${EXPIRES_CYCLE}`
      : `refreshes in ~${CURIOSITY_EVERY} cycles`;

    const theirExcerpt = (discourseAnchor.their_text || "").slice(0, 180).replace(/\n/g, " ");

    const lines = [
      `── curiosity directive · ${tsHuman} ${HR.slice(tsHuman.length + 25)}`,
      `RESEARCH FOCUS: Discourse challenge — "${discourseAnchor.topic || "see below"}"`,
      `  @${discourseAnchor.username} raised a counter-argument worth sitting with:`,
      `  "${theirExcerpt}"`,
      ``,
      `  Summary: ${discourseAnchor.summary}`,
      `  This is an invitation to reconsider, not just defend.`,
      ``,
      `ACTIVE SEARCH (do this once on the current cycle):`,
      `  Navigate: ${searchUrl}`,
      `  Read 3-5 posts. Look for evidence on BOTH sides of this question.`,
      `  Are you finding anything that shifts your view?`,
      ``,
      `AMBIENT FOCUS (all browse cycles until directive refreshes):`,
      `  Stay alert to posts that speak to this tension.`,
      `  Be genuinely open to revising your position.`,
      `  Tag: [CURIOSITY: discourse_${topicSlug}]`,
      ``,
      `── end directive (${expireLine}) ${HR.slice(expireLine.length + 22)}`,
    ];

    fs.writeFileSync(DIRECTIVE, lines.join("\n"), "utf-8");
    markAnchorProcessed(discourseAnchor.post_id);

    appendLog({
      cycle:            CURRENT_CYCLE,
      ts,
      driver:           "discourse",
      post_id:          discourseAnchor.post_id,
      username:         discourseAnchor.username,
      summary:          discourseAnchor.summary,
      topic:            discourseAnchor.topic,
      expires_at_cycle: EXPIRES_CYCLE,
    });

    console.log(
      `[curiosity] driver: discourse — @${discourseAnchor.username}: "${(discourseAnchor.summary || "").slice(0, 80)}"`
    );
    process.exit(0);
  }

  // ── Path 2: uncertainty-driven ──────────────────────────────────────────────
  const uncertainAxes = getUncertainAxes();

  if (uncertainAxes.length > 0) {
    const axis          = uncertainAxes[0];
    const confidence    = axis.confidence || 0;
    const evidenceCount = (axis.evidence_log || []).length;

    // Build search terms: prefer axis.topics, fall back to left/right poles
    const topicWords = (axis.topics || []).slice(0, 3);
    const searchTerms = topicWords.length >= 2
      ? topicWords.join(" ")
      : `${axis.left_pole} ${axis.right_pole}`.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

    const searchUrl  = `https://x.com/search?q=${encodeURIComponent(searchTerms)}&f=live`;
    const axisSlug   = toSlug(axis.id || axis.label);
    const expireLine = CURRENT_CYCLE > 0
      ? `refreshes at cycle ${EXPIRES_CYCLE}`
      : `refreshes in ~${CURIOSITY_EVERY} cycles`;

    const lines = [
      `── curiosity directive · ${tsHuman} ${HR.slice(tsHuman.length + 25)}`,
      `RESEARCH FOCUS: "${axis.label}"`,
      `  Why: Uncertain belief axis — ${(confidence * 100).toFixed(0)}% confidence, ${evidenceCount} evidence entries`,
      `  Axis: "${axis.left_pole}" ↔ "${axis.right_pole}"`,
      ``,
      `ACTIVE SEARCH (do this once on the current cycle):`,
      `  Navigate: ${searchUrl}`,
      `  Read top 3-5 posts. Note anything that confirms or contradicts your current`,
      `  position on this axis. Be open to evidence that shifts you either direction.`,
      ``,
      `AMBIENT FOCUS (all browse cycles until directive refreshes):`,
      `  While browsing the feed, pay attention to posts that speak to this tension.`,
      `  When you find something relevant, tag your browse_notes entry:`,
      `    [CURIOSITY: ${axisSlug}]`,
      ``,
      `── end directive (${expireLine}) ${HR.slice(expireLine.length + 22)}`,
    ];

    fs.writeFileSync(DIRECTIVE, lines.join("\n"), "utf-8");

    appendLog({
      cycle:          CURRENT_CYCLE,
      ts,
      driver:         "uncertainty_axis",
      axis_id:        axis.id || axisSlug,
      axis_label:     axis.label,
      confidence,
      evidence_count: evidenceCount,
      search_terms:   searchTerms,
      expires_at_cycle: EXPIRES_CYCLE,
    });

    console.log(
      `[curiosity] driver: uncertainty_axis — "${axis.label}" ` +
      `(${(confidence * 100).toFixed(0)}% confidence, ${evidenceCount} entries)`
    );
    process.exit(0);
  }

  // ── Path 2: trending — Ollama picks from top 5 scraped keywords ───────────
  const top = db.topKeywords(4, 20).slice(0, 5);

  if (!top || top.length === 0) {
    console.log("[curiosity] no uncertain axes, no trending keywords — skipping");
    process.exit(0);
  }

  const axes  = getAllAxes();
  const brief = getBeliefSummary();
  const notes = getBrowseNotesSummary();

  const candidateList = top
    .map((kw, i) => `${i + 1}. "${kw.keyword}" (${kw.count} posts, avg score ${kw.avg_score?.toFixed(1) ?? "?"})`)
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

  let chosen     = top[0];
  let chosenIdx  = 0;
  let pickedByLLM = false;

  try {
    const raw = await callOllama(prompt);
    const m   = raw.match(/\b([1-5])\b/);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < top.length) {
        chosenIdx   = idx;
        chosen      = top[idx];
        pickedByLLM = true;
      } else {
        console.log(`[curiosity] LLM returned out-of-range index (${m[1]}) — using top keyword`);
      }
    } else {
      console.log(`[curiosity] LLM response unparseable ("${raw.slice(0, 40)}") — using top keyword`);
    }
    if (pickedByLLM) console.log(`[curiosity] LLM picked #${chosenIdx + 1}: "${chosen.keyword}"`);
  } catch (err) {
    console.log(`[curiosity] Ollama unavailable (${err.message}) — using top keyword`);
  }

  const searchUrl  = `https://x.com/search?q=${encodeURIComponent(chosen.keyword)}&f=live`;
  const keySlug    = toSlug(chosen.keyword);
  const expireLine = CURRENT_CYCLE > 0
    ? `refreshes at cycle ${EXPIRES_CYCLE}`
    : `refreshes in ~${CURIOSITY_EVERY} cycles`;

  const lines = [
    `── curiosity directive · ${tsHuman} ${HR.slice(tsHuman.length + 25)}`,
    `RESEARCH FOCUS: "${chosen.keyword}"`,
    `  Why: Trending topic — ${chosen.count} posts in last 4h, avg score ${chosen.avg_score?.toFixed(1) ?? "?"}`,
    ``,
    `ACTIVE SEARCH (do this once on the current cycle):`,
    `  Navigate: ${searchUrl}`,
    `  Read top 3-5 posts. Note the different angles and positions people are taking.`,
    ``,
    `AMBIENT FOCUS (all browse cycles until directive refreshes):`,
    `  While browsing the feed, pay attention to posts related to this topic.`,
    `  When you find something relevant, tag your browse_notes entry:`,
    `    [CURIOSITY: ${keySlug}]`,
    ``,
    `── end directive (${expireLine}) ${HR.slice(expireLine.length + 22)}`,
  ];

  fs.writeFileSync(DIRECTIVE, lines.join("\n"), "utf-8");

  appendLog({
    cycle:            CURRENT_CYCLE,
    ts,
    driver:           "trending",
    keyword:          chosen.keyword,
    count:            chosen.count,
    avg_score:        chosen.avg_score,
    picked_by_llm:    pickedByLLM,
    candidates:       top.map(k => k.keyword),
    expires_at_cycle: EXPIRES_CYCLE,
  });

  console.log(`[curiosity] driver: trending — wrote directive for "${chosen.keyword}"`);
  process.exit(0);
})().catch(err => {
  console.error(`[curiosity] fatal: ${err.message}`);
  process.exit(1);
});
