#!/usr/bin/env node
/**
 * runner/critique.js — coherence critique using local Ollama
 *
 * Runs after each TWEET or QUOTE cycle.
 * Reads the latest journal + post (tweet mode) or browse_notes + post (quote mode),
 * calls qwen2.5:7b via Ollama, writes state/critique.md.
 *
 * The next browse cycle reads critique.md and addresses any coherence gaps.
 *
 * Usage:
 *   node critique.js            # tweet mode (journal + tweet)
 *   node critique.js --quote    # quote mode (browse_notes + quote tweet)
 *
 * Requires: ollama running locally (brew install ollama && ollama pull qwen2.5:7b)
 * Falls back silently if Ollama is unavailable.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT         = path.resolve(__dirname, "..");
const JOURNALS_DIR = path.join(ROOT, "journals");
const POSTS_LOG    = path.join(ROOT, "state", "posts_log.json");
const BROWSE_NOTES = path.join(ROOT, "state", "browse_notes.md");
const ONTOLOGY     = path.join(ROOT, "state", "ontology.json");
const CRITIQUE_OUT = path.join(ROOT, "state", "critique.md");

const OLLAMA_URL    = process.env.OLLAMA_URL  || "http://localhost:11434/api/generate";
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const HISTORY_OUT   = path.join(ROOT, "state", "critique_history.jsonl");

const isQuoteMode   = process.argv.includes("--quote");
const isHistoryMode = process.argv.includes("--history");

// --cycle N: only critique if a post for this cycle exists in posts_log
const cycleArgIdx = process.argv.indexOf("--cycle");
const cycleArg    = cycleArgIdx !== -1 ? parseInt(process.argv[cycleArgIdx + 1], 10) : null;

// ── History mode ─────────────────────────────────────────────────────────────
// node critique.js --history   → print coherence trend table

if (isHistoryMode) {
  if (!fs.existsSync(HISTORY_OUT)) {
    console.log("No critique history yet.");
    process.exit(0);
  }
  const entries = fs.readFileSync(HISTORY_OUT, "utf-8")
    .trim().split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const COL = { Strong: "✓", Adequate: "~", Weak: "✗", null: "?" };
  console.log("\n  Cycle  Mode    Coherence   Watch");
  console.log("  " + "─".repeat(72));
  for (const e of entries) {
    const icon  = COL[e.coherence] || "?";
    const ts    = (e.timestamp || "").slice(0, 16).replace("T", " ");
    const watch = (e.watch || "").slice(0, 55);
    const pad   = (s, n) => String(s || "?").padEnd(n);
    console.log(`  ${pad(e.cycle, 6)} ${pad(e.mode, 8)} ${icon} ${pad(e.coherence, 10)} ${watch}`);
  }
  const total = entries.length;
  const counts = entries.reduce((a, e) => { a[e.coherence] = (a[e.coherence] || 0) + 1; return a; }, {});
  console.log("  " + "─".repeat(72));
  console.log(`  ${total} critiques — Strong: ${counts.Strong || 0}  Adequate: ${counts.Adequate || 0}  Weak: ${counts.Weak || 0}\n`);
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLatestJournal() {
  if (!fs.existsSync(JOURNALS_DIR)) return null;
  const files = fs.readdirSync(JOURNALS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f))
    .sort()
    .reverse();
  if (!files.length) return null;
  const raw  = fs.readFileSync(path.join(JOURNALS_DIR, files[0]), "utf-8");
  const text = stripHtml(raw).slice(0, 3500);
  return { name: files[0], text };
}

function getLatestPost(type) {
  if (!fs.existsSync(POSTS_LOG)) return null;
  // Agent sometimes writes \' (invalid JSON escape) — strip it defensively
  const raw   = fs.readFileSync(POSTS_LOG, "utf-8").replace(/\\'/g, "'");
  const data  = JSON.parse(raw);
  const posts = (data.posts || []).slice().reverse();
  return type ? (posts.find(p => p.type === type) || posts[0]) : posts[0];
}

function getBrowseNotes() {
  if (!fs.existsSync(BROWSE_NOTES)) return "";
  return fs.readFileSync(BROWSE_NOTES, "utf-8").slice(0, 3000);
}

function getAxesSummary() {
  if (!fs.existsSync(ONTOLOGY)) return "(no axes yet)";
  const data = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
  return (data.axes || []).slice(0, 6)
    .map(a => `- ${a.label}: ${a.left_pole} <-> ${a.right_pole}`)
    .join("\n") || "(no axes yet)";
}

// Extract a named field from the model output (e.g. "COHERENCE: Strong")
function parseField(text, field) {
  const m = text.match(new RegExp(`${field}:\\s*(.+?)(?:\\n|$)`, "i"));
  return m ? m[1].trim() : null;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildTweetPrompt(journal, post, axes) {
  return `You are a philosophical editor. Evaluate the COHERENCE OF THOUGHT in this AI agent output.

ACTIVE BELIEF AXES:
${axes}

JOURNAL ENTRY (agent observations and synthesis):
${journal.text}

TWEET POSTED:
"${post.content}"
${post.tweet_url ? `URL: ${post.tweet_url}` : ""}

Evaluate coherence only. Be direct and brief. Use this exact format:

COHERENCE: [Strong / Adequate / Weak]

GAPS: [Any logical leaps between observations and the conclusion. If none, write "None."]

TWEET vs JOURNAL: [Does the tweet faithfully compress the journal insight, or does it distort/simplify?]

WATCH: [One specific thing to verify or deepen in the next browse window. One sentence.]`;
}

function buildQuotePrompt(browseNotes, post, axes) {
  return `You are a philosophical editor. Evaluate the COHERENCE OF THOUGHT in this AI agent output.

ACTIVE BELIEF AXES:
${axes}

BROWSE NOTES (what the agent was thinking when it chose this quote):
${browseNotes || "(not available)"}

QUOTE TWEET POSTED:
"${post.content}"
${post.tweet_url ? `URL: ${post.tweet_url}` : ""}

Evaluate coherence only. Be direct and brief. Use this exact format:

COHERENCE: [Strong / Adequate / Weak]

GAPS: [Does the commentary follow from the agent current axes and browse context? Any logical leap?]

FRAMING: [Is the one-liner accurate to the tension being called out, or does it oversimplify?]

WATCH: [One thing to probe further in the next browse window. One sentence.]`;
}

// ── Ollama call ───────────────────────────────────────────────────────────────

async function callOllama(prompt) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        model:   OLLAMA_MODEL,
        prompt,
        stream:  false,
        options: { temperature: 0.2, num_predict: 350 },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data = await res.json();
    return (data.response || "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const axes = getAxesSummary();

  let prompt;
  let cycleLabel;
  let postRef;
  let currentPost;  // captured for history logging

  if (isQuoteMode) {
    currentPost = getLatestPost("quote");
    if (!currentPost) { console.log("[critique] no quote post found — skipping"); return; }
    if (cycleArg !== null && currentPost.cycle !== cycleArg) {
      console.log(`[critique] no quote posted this cycle (${cycleArg}) — skipping`);
      return;
    }
    const notes = getBrowseNotes();
    prompt     = buildQuotePrompt(notes, currentPost, axes);
    cycleLabel = `quote cycle ${currentPost.cycle || "?"}`;
    postRef    = currentPost.tweet_url || currentPost.id || "?";
  } else {
    const journal = getLatestJournal();
    currentPost   = getLatestPost();
    if (!journal || !currentPost) { console.log("[critique] nothing to critique yet — skipping"); return; }
    if (cycleArg !== null && currentPost.cycle !== cycleArg) {
      console.log(`[critique] no tweet posted this cycle (${cycleArg}) — skipping`);
      return;
    }
    prompt     = buildTweetPrompt(journal, currentPost, axes);
    cycleLabel = `tweet cycle ${currentPost.cycle || "?"}`;
    postRef    = `journal: ${journal.name} | tweet: ${currentPost.tweet_url || currentPost.id || "?"}`;
  }

  console.log(`[critique] evaluating coherence (${OLLAMA_MODEL}) — ${cycleLabel}...`);

  let result;
  try {
    result = await callOllama(prompt);
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("[critique] Ollama timed out (90s) — skipping");
    } else {
      console.log(`[critique] Ollama unavailable: ${err.message} — skipping`);
    }
    return;
  }

  if (!result) { console.log("[critique] empty response — skipping"); return; }

  // Parse structured fields
  const coherence = parseField(result, "COHERENCE");
  const watch     = parseField(result, "WATCH");
  const gaps      = parseField(result, "GAPS");

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");

  // Write state/critique.md (read by next browse cycle)
  const output = [
    `# Critique · ${timestamp} · ${cycleLabel}`,
    "",
    result,
    "",
    `---`,
    `*${postRef}*`,
    "",
  ].join("\n");
  fs.writeFileSync(CRITIQUE_OUT, output);

  // Append one JSON line to critique_history.jsonl
  const historyEntry = {
    timestamp: new Date().toISOString(),
    cycle:     currentPost ? (currentPost.cycle || null) : null,
    mode:      isQuoteMode ? "quote" : "tweet",
    coherence: coherence || null,
    gaps:      gaps      || null,
    watch:     watch     || null,
    post_url:  currentPost ? (currentPost.tweet_url || currentPost.id || null) : null,
  };
  fs.appendFileSync(HISTORY_OUT, JSON.stringify(historyEntry) + "\n");

  // Log with clear delimiters so it stands out in runner.log
  const line = "─".repeat(60);
  console.log(`[critique] ${line}`);
  console.log(`[critique] ${cycleLabel.toUpperCase()} · coherence: ${coherence || "?"}`);
  console.log(`[critique] ${line}`);
  console.log(result);
  console.log(`[critique] ${line}`);
  console.log(`[critique] wrote state/critique.md + appended critique_history.jsonl`);
}

main().catch(err => {
  console.error("[critique] fatal:", err.message);
  process.exit(1);
});
