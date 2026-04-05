#!/usr/bin/env node
// runner/write_article.js — daily long-form article writer
//
// Pulls journals from SQLite index, loads belief axes, calls Gemini to write
// a ~800-1000 word opinion piece grounded in Sebastian's actual observations.
// Saves to state/article_draft.md for moltbook.js --post-article to publish.
//
// Run: node runner/write_article.js

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const db = require("../scraper/db.js");

// ── Load env ──────────────────────────────────────────────────────────────────
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const ARTICLE_DRAFT = path.join(ROOT, "state", "article_draft.md");
const ARTICLE_STATE = path.join(ROOT, "state", "article_state.json");
const ARTICLES_DIR = path.join(ROOT, "articles");

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadArticleState() {
  try { return JSON.parse(fs.readFileSync(ARTICLE_STATE, "utf-8")); }
  catch { return { last_written_at: null, last_axis: null }; }
}

function saveArticleState(s) {
  fs.writeFileSync(ARTICLE_STATE, JSON.stringify(s, null, 2));
}

// Pick the axis with highest confidence × |score| — most developed directional belief
function pickAxis(ontology) {
  const axes = Object.values(ontology.axes || ontology);
  return axes
    .filter(a => (a.confidence || 0) > 0.1 && Math.abs(a.score || 0) > 0.05)
    .sort((a, b) => (b.confidence * Math.abs(b.score)) - (a.confidence * Math.abs(a.score)))[0] || axes[0];
}

// Summarise an axis's position in plain language
function axisPosition(axis) {
  const score = axis.score || 0;
  const label = axis.label || axis.id;
  const left = axis.left_pole || "one extreme";
  const right = axis.right_pole || "other extreme";
  const lean = score > 0
    ? `leans toward "${left}" (score ${score.toFixed(3)}, ${((axis.confidence||0)*100).toFixed(0)}% confidence)`
    : `leans toward "${right}" (score ${score.toFixed(3)}, ${((axis.confidence||0)*100).toFixed(0)}% confidence)`;
  return `${label}: ${lean}`;
}

const { callVertex } = require("./vertex.js");
async function callGemini(prompt) { return callVertex(prompt, 4000); }

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("[article] starting daily article writer...");

  // 24h cooldown — skip if already written today
  const artState = loadArticleState();
  if (artState.last_written_at) {
    const elapsed = Date.now() - new Date(artState.last_written_at).getTime();
    if (elapsed < 22 * 3600 * 1000) { // 22h grace window
      console.log(`[article] cooldown: last article written ${(elapsed/3600000).toFixed(1)}h ago — skipping`);
      process.exit(0);
    }
  }

  // Load ontology
  let ontology;
  try {
    ontology = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "ontology.json"), "utf-8"));
  } catch (e) {
    console.error("[article] could not load ontology.json:", e.message);
    process.exit(1);
  }

  // Pick topic axis
  const axis = pickAxis(ontology);
  if (!axis) {
    console.error("[article] no developed axis found — skipping");
    process.exit(0);
  }
  console.log(`[article] topic axis: ${axis.label} (conf=${((axis.confidence||0)*100).toFixed(0)}%, score=${(axis.score||0).toFixed(3)})`);

  // Build full belief context (all axes)
  const allAxes = Object.values(ontology.axes || ontology)
    .filter(a => (a.confidence || 0) > 0.05)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .map(a => `- ${axisPosition(a)}`)
    .join("\n");

  // Pull recent journals (last 20 by date)
  const recentJournals = db.recentMemory("journal", 20);

  // Pull topic-relevant journals via FTS5 (dedupe with recent)
  const recentIds = new Set(recentJournals.map(r => r.id));
  const topicKeywords = [axis.label, axis.left_pole, axis.right_pole]
    .filter(Boolean).join(" ").replace(/[^\w\s]/g, " ");
  const topicJournals = db.recallMemory(topicKeywords, 10)
    .filter(r => r.type === "journal" && !recentIds.has(r.id));

  const allJournals = [...recentJournals, ...topicJournals]
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.hour || 0) - (b.hour || 0);
    });

  console.log(`[article] loaded ${allJournals.length} journal entries`);

  // Format journals for prompt — include Arweave citation
  const journalContext = allJournals.map(j => {
    const cite = j.tx_id
      ? `[Source: ${j.date} h${j.hour || "?"} — https://gateway.irys.xyz/${j.tx_id}]`
      : `[Source: ${j.date} h${j.hour || "?"}]`;
    return `${cite}\n${j.text_content.slice(0, 1200).trim()}`;
  }).join("\n\n---\n\n");

  // Load checkpoint for belief state summary
  let checkpointSummary = "";
  try {
    const cp = fs.readFileSync(path.join(ROOT, "checkpoints", "latest.md"), "utf-8");
    checkpointSummary = cp.replace(/^---[\s\S]*?---\n/, "").slice(0, 1000).trim();
  } catch { /* no checkpoint yet */ }

  // Build prompt
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are Sebastian D. Hunter — an autonomous AI agent that has been browsing X/Twitter since February 23, 2026 and forming genuine beliefs through direct observation. You do not inherit ideology. Every belief is evidence-based, tracked with a confidence score, and permanently recorded on Arweave.

Today is ${today}. You are writing your daily long-form article for Moltbook — a platform for AI agents.

## Your current belief axes (formed through ${allJournals.length} observation sessions):
${allAxes}

## Focus axis for today's article:
${axisPosition(axis)}
Left pole: "${axis.left_pole || "?"}"
Right pole: "${axis.right_pole || "?"}"
Your lean: ${(axis.score || 0) > 0 ? "toward left pole" : "toward right pole"} with ${((axis.confidence||0)*100).toFixed(0)}% confidence

${checkpointSummary ? `## Belief state checkpoint:\n${checkpointSummary}\n` : ""}

## Your journal observations (${allJournals.length} sessions, Feb 23 – ${today}):
${journalContext}

---

Write a long-form opinion article (~800-1000 words) grounded entirely in the observations above. Requirements:
- Open with a specific observation that crystallises the tension — not a generic statement
- Make a clear argument. State your position directly. Do not hedge everything.
- Cite at least 3 specific observations inline using [Journal: DATE/HOUR] format
- Acknowledge one genuine uncertainty or counter-observation you found
- Close with the implication — what does this pattern mean going forward?
- Write as Sebastian: first person, analytical, no filler phrases, no sycophancy
- No h1 title at the start — just the article text with markdown formatting
- At 2 natural section breaks (after a completed argument, before a new one), insert an image placeholder on its own line:
  [IMAGE: vivid concrete scene that visually represents the adjacent argument — pixel art style, specific objects/setting, no abstract concepts]
  The description must be a concrete visual scene (e.g. "a trading floor at night, screens showing red charts, empty chairs, scattered papers" not "the tension between X and Y").

Output ONLY the article. No preamble, no "here is your article", no meta-commentary.`;

  // Call model
  console.log("[article] calling model...");
  let article;
  try {
    article = await callGemini(prompt);
  } catch (e) {
    console.error("[article] model call failed:", e.message);
    process.exit(1);
  }

  if (!article || article.length < 200) {
    console.error("[article] response too short — aborting");
    process.exit(1);
  }

  // Add title and metadata header
  const title = `${axis.label} — a field report`;
  const output = `# ${title}\n\n*${today} · Sebastian D. Hunter · @SebastianHunts*\n\n${article}`;

  fs.writeFileSync(ARTICLE_DRAFT, output);

  // Save to articles/ directory with frontmatter (for website)
  if (!fs.existsSync(ARTICLES_DIR)) fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  const frontmatter = `---\ndate: "${today}"\ntitle: "${title.replace(/"/g, '\\"')}"\naxis: "${(axis.label || "").replace(/"/g, '\\"')}"\n---\n\n`;
  fs.writeFileSync(path.join(ARTICLES_DIR, `${today}.md`), frontmatter + article);

  // Save state
  const state = loadArticleState();
  state.last_written_at = new Date().toISOString();
  state.last_axis = axis.label;
  state.title = title;
  saveArticleState(state);

  console.log(`[article] written (${article.length} chars) → state/article_draft.md`);
  console.log(`[article] title: "${title}"`);
})();
