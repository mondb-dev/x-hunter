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

const OLLAMA_URL   = process.env.OLLAMA_URL  || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

const isQuoteMode  = process.argv.includes("--quote");

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

  if (isQuoteMode) {
    const post = getLatestPost("quote");
    if (!post) { console.log("[critique] no quote post found — skipping"); return; }
    const notes = getBrowseNotes();
    prompt     = buildQuotePrompt(notes, post, axes);
    cycleLabel = `quote cycle ${post.cycle || "?"}`;
    postRef    = post.tweet_url || post.id || "?";
  } else {
    const journal = getLatestJournal();
    const post    = getLatestPost();
    if (!journal || !post) { console.log("[critique] nothing to critique yet — skipping"); return; }
    prompt     = buildTweetPrompt(journal, post, axes);
    cycleLabel = `tweet cycle ${post.cycle || "?"}`;
    postRef    = `journal: ${journal.name} | tweet: ${post.tweet_url || post.id || "?"}`;
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

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
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
  console.log("[critique] wrote state/critique.md");
  console.log(result);
}

main().catch(err => {
  console.error("[critique] fatal:", err.message);
  process.exit(1);
});
