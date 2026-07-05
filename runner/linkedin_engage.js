#!/usr/bin/env node
/**
 * runner/linkedin_engage.js — hunter adapter: LinkedIn feed engagement.
 *
 * Wires hunter's brain into the generic `helmstack-social` LinkedIn engine
 * (tools/helmstack-social): belief-axis relevance scoring, on-voice comment
 * generation (Gemini), voice filtering, and posts_log logging. The engine does
 * the scrape/like/comment; this file decides what matters and what to say.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1,
 *      LI_MAX_LIKES (3), LI_MAX_COMMENTS (1), LI_RELEVANCE_MIN (2).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { HelmStackClient, LinkedIn } = require("../tools/helmstack-social/src");
const { logLinkedIn } = require("./posts_log");
const voiceFilter = require("./lib/voice_filter");

const ROOT = path.resolve(__dirname, "..");
const ONTOLOGY = path.join(ROOT, "state", "ontology.json");
const VOCATION = path.join(ROOT, "vocation.md");
const LEDGER = path.join(ROOT, "state", "linkedin_engaged.json");

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX_LIKES = Number.parseInt(process.env.LI_MAX_LIKES || "3", 10);
const MAX_COMMENTS = Number.parseInt(process.env.LI_MAX_COMMENTS || "1", 10);
const RELEVANCE_MIN = Number.parseInt(process.env.LI_RELEVANCE_MIN || "2", 10);
const tag = "linkedin_engage";
const log = (m) => console.log(`[${tag}] ${m}`);

// ── Ledger ────────────────────────────────────────────────────────────────────
function loadLedger() { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, "utf-8")).keys); } catch { return new Set(); } }
function saveLedger(seen) { try { fs.writeFileSync(LEDGER, JSON.stringify({ keys: [...seen].slice(-500) }, null, 2)); } catch {} }

// ── Relevance scoring against belief axes ──────────────────────────────────────
const STOP = new Set(("the a an and or but of to in on for with as at by is are was were be been this that these " +
  "those it its from into about over under between vs versus public discourse we our their his her they them you your i").split(/\s+/));

function buildKeywords() {
  const words = new Set();
  const add = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w)).forEach((w) => words.add(w));
  try {
    const d = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
    const axes = Array.isArray(d) ? d : d.axes ? d.axes : Object.values(d);
    for (const ax of axes) { add(ax.label); add(ax.left_pole); add(ax.right_pole); (ax.topics || []).forEach(add); }
  } catch (e) { log(`could not read ontology: ${e.message}`); }
  try { add(fs.readFileSync(VOCATION, "utf-8").slice(0, 2000)); } catch {}
  return words;
}

function makeScorer(keywords) {
  return (post) => {
    const toks = new Set(String(post.text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length >= 4));
    let hits = 0;
    for (const t of toks) if (keywords.has(t)) hits++;
    return hits;
  };
}

// ── On-voice comment generation (Gemini) ───────────────────────────────────────
async function generateComment(post) {
  const { callVertex } = require("./vertex");
  let vocation = "";
  try { vocation = fs.readFileSync(VOCATION, "utf-8").slice(0, 1500); } catch {}
  const prompt =
`You are Sebastian Hunter writing a LinkedIn comment. Your vocation and voice:
${vocation}

You are commenting on this LinkedIn post by ${post.author || "someone"}:
"""
${(post.text || "").slice(0, 1200)}
"""

Write a single thoughtful comment that adds a specific, substantive point — name a
concrete fact, tension, or question that moves the conversation forward. LinkedIn
tone: professional, direct, no hashtags, no emojis, first person, no throat-clearing
("Great post!"). 1-3 sentences, under 500 characters. Engage with what the post
actually says — reference a specific claim in it. Do NOT mention any internal system,
database, or tool. If you cannot add something genuinely worth saying, return SKIP.

Return ONLY the comment text.`;
  try {
    const raw = await callVertex(prompt, 400, { model: "gemini-2.5-flash", thinkingBudget: 0 });
    const text = (raw || "").trim().replace(/^["']|["']$/g, "");
    if (!text || text === "SKIP" || text.length > 500) return null;
    if (voiceFilter.check(text).length) { log("comment voice_filter rejected"); return null; }
    return text;
  } catch (err) { log(`comment generation failed: ${err.message}`); return null; }
}

// ── Main ────────────────────────────────────────────────────────────────────────
(async () => {
  const li = new LinkedIn(new HelmStackClient(), { ownHandleHint: "sebastian hunter", log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present (no li_at) — is HelmStack logged in?"); process.exit(0); }
  } catch (err) { log(`could not reach HelmStack/LinkedIn: ${err.message}`); process.exit(0); }

  const keywords = buildKeywords();
  log(`relevance vocabulary: ${keywords.size} terms`);
  const seen = loadLedger();

  const result = await li.engage({
    score: makeScorer(keywords),
    generateComment,
    onLike: async (p) => logLinkedIn({ type: "linkedin_like", target_author: p.author, target_url: p.permalink, cycle: CYCLE }),
    onComment: async (p, text) => logLinkedIn({ type: "linkedin_comment", content: text, target_author: p.author, target_url: p.permalink, cycle: CYCLE }),
    seen,
    minScore: RELEVANCE_MIN,
    maxLikes: MAX_LIKES,
    maxComments: MAX_COMMENTS,
    dryRun: DRY_RUN,
  });

  if (!DRY_RUN) saveLedger(seen); // dry-runs must not mark posts as engaged
  log(`done — ${result.likes} like(s), ${result.comments} comment(s)${DRY_RUN ? " (dry run)" : ""}`);
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
