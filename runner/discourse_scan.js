#!/usr/bin/env node
/**
 * runner/discourse_scan.js — scan reply exchanges for substantive counter-reasoning
 *
 * Reads recent interactions from state/interactions.json, identifies exchanges not
 * yet scanned, and uses local Ollama to assess whether the user's message contains
 * genuine counter-reasoning that challenges Hunter's stated positions.
 *
 * Substantive exchanges are appended to state/discourse_anchors.jsonl, which
 * runner/curiosity.js reads as its highest-priority curiosity driver.
 *
 * This script runs every browse cycle but processes only NEW exchanges (those whose
 * IDs are not in state/discourse_scan_state.json). Typically 0–2 new items per run.
 *
 * Non-fatal: if Ollama is unavailable or interactions.json is missing, exits cleanly.
 *
 * Usage: node runner/discourse_scan.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT         = path.resolve(__dirname, "..");
const INTERACTIONS = path.join(ROOT, "state", "interactions.json");
const ANCHORS_OUT  = path.join(ROOT, "state", "discourse_anchors.jsonl");
const SCAN_STATE   = path.join(ROOT, "state", "discourse_scan_state.json");

const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

const MIN_TEXT_LEN  = 60;   // shorter messages are rarely substantive arguments
const MAX_SCAN_IDS  = 300;  // rolling buffer cap for scanned_ids

// ── State helpers ─────────────────────────────────────────────────────────────

function loadScanState() {
  try {
    const data = JSON.parse(fs.readFileSync(SCAN_STATE, "utf-8"));
    if (!Array.isArray(data.scanned_ids)) data.scanned_ids = [];
    return data;
  } catch {
    return { scanned_ids: [] };
  }
}

function saveScanState(state) {
  // Keep rolling buffer bounded
  if (state.scanned_ids.length > MAX_SCAN_IDS) {
    state.scanned_ids = state.scanned_ids.slice(-MAX_SCAN_IDS);
  }
  fs.writeFileSync(SCAN_STATE, JSON.stringify(state, null, 2), "utf-8");
}

// ── Ollama call ───────────────────────────────────────────────────────────────

async function callOllama(prompt) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        model:   OLLAMA_MODEL,
        prompt,
        stream:  false,
        options: { temperature: 0.0, num_predict: 80 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.response || "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Discourse quality assessment ─────────────────────────────────────────────

async function assessExchange(theirText, ourReply) {
  const prompt =
`You are analyzing a reply exchange. Does the user's message contain substantive
counter-reasoning — a specific logical argument, named evidence, or framing that
genuinely challenges or complicates a stated position?

NOT substantive: insults, vague disagreement, memes, one-liners, emotional reactions,
simple "you're wrong", rhetorical questions without backing.

YES substantive: specific claims with reasoning ("because X implies Y"),
named evidence or historical examples, logical if-then arguments, principled
distinctions, empirical counter-claims.

User's message: "${theirText.replace(/"/g, "'").slice(0, 400)}"
Agent's reply: "${ourReply.replace(/"/g, "'").slice(0, 200)}"

Reply with JSON only, no other text:
{"is_substantive":false}
or
{"is_substantive":true,"summary":"one sentence describing their argument","topic":"2-3 word topic label"}`;

  const raw = await callOllama(prompt);

  // Strip markdown fences if present
  const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  // Extract first JSON object
  const m = cleaned.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`unparseable response: "${raw.slice(0, 60)}"`);

  return JSON.parse(m[0]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  // Load interactions
  if (!fs.existsSync(INTERACTIONS)) {
    console.log("[discourse_scan] no interactions.json yet — skipping");
    process.exit(0);
  }

  let interactions;
  try {
    interactions = JSON.parse(fs.readFileSync(INTERACTIONS, "utf-8"));
  } catch (e) {
    console.log(`[discourse_scan] could not parse interactions.json: ${e.message}`);
    process.exit(0);
  }

  const replies = interactions.replies || [];
  if (!replies.length) {
    console.log("[discourse_scan] no reply history yet — skipping");
    process.exit(0);
  }

  const state     = loadScanState();
  const scannedSet = new Set(state.scanned_ids);

  // Find unscanned exchanges with enough text to assess
  const toScan = replies.filter(r =>
    r.id &&
    !scannedSet.has(r.id) &&
    (r.their_text || "").length >= MIN_TEXT_LEN
  );

  if (!toScan.length) {
    console.log("[discourse_scan] no new exchanges to scan");
    process.exit(0);
  }

  const stateDir = path.join(ROOT, "state");
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  let scanned = 0;
  let anchors  = 0;

  for (const reply of toScan) {
    const theirText = reply.their_text || "";
    const ourReply  = reply.our_reply  || "";

    let result;
    try {
      result = await assessExchange(theirText, ourReply);
    } catch (e) {
      // Ollama unavailable or parse error — skip without marking as scanned (allow retry next cycle)
      console.log(`[discourse_scan] assessment failed for ${reply.id}: ${e.message} — will retry`);
      continue;
    }

    state.scanned_ids.push(reply.id);
    scanned++;

    if (result.is_substantive) {
      const anchor = {
        ts:         reply.replied_at || new Date().toISOString(),
        post_id:    reply.id,
        username:   reply.from || "unknown",
        their_text: theirText.slice(0, 500),
        summary:    result.summary  || "",
        topic:      result.topic    || "",
        our_reply:  ourReply.slice(0, 280),
      };
      fs.appendFileSync(ANCHORS_OUT, JSON.stringify(anchor) + "\n", "utf-8");
      anchors++;
      console.log(`[discourse_scan] anchor: @${anchor.username} — "${(result.summary || "").slice(0, 80)}"`);
    }
  }

  saveScanState(state);
  console.log(`[discourse_scan] scanned ${scanned} exchange(s), ${anchors} anchor(s) written`);

  process.exit(0);
})().catch(err => {
  console.error(`[discourse_scan] fatal: ${err.message}`);
  process.exit(0); // non-fatal: exit 0 so run.sh continues
});
