#!/usr/bin/env node
/**
 * runner/linkedin_engage.js — LinkedIn feed engagement for Sebastian
 *
 * Flow:
 *   1. Scrape the feed (HelmStack LinkedIn engine).
 *   2. Score each post for relevance to Sebastian's belief axes (state/ontology.json)
 *      — keyword overlap against axis labels/poles. Skips own posts and posts
 *      already engaged with (ledger: state/linkedin_engaged.json).
 *   3. Like the top-N relevant posts (default 3).
 *   4. Generate one on-voice comment (Gemini via callVertex) for the single most
 *      relevant post above a threshold, voice-filter it, and post it.
 *   5. Log everything to posts_log.json and the ledger.
 *
 * Env:
 *   HELMSTACK_AUTH_TOKEN   required
 *   HELMSTACK_DRY_RUN=1    scrape + score + generate, but no like/comment
 *   LI_MAX_LIKES           default 3
 *   LI_MAX_COMMENTS        default 1
 *   LI_RELEVANCE_MIN       default 2 (min keyword hits to act)
 *
 * Exit 0 always (engagement is best-effort; failures are logged, not fatal).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const li = require("./lib/linkedin");
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

// ── Ledger (avoid re-engaging the same post) ─────────────────────────────────
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf-8")); } catch { return { keys: [] }; }
}
function saveLedger(l) {
  // cap to last 500 keys
  l.keys = l.keys.slice(-500);
  try { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); } catch {}
}
function postKey(p) {
  return p.permalink || `${(p.author || "").toLowerCase()}::${(p.text || "").slice(0, 60).toLowerCase()}`;
}

// ── Relevance scoring against belief axes ────────────────────────────────────
const STOP = new Set(("the a an and or but of to in on for with as at by is are was were be been " +
  "this that these those it its from into about over under between vs versus public discourse " +
  "we our their his her they them you your i").split(/\s+/));

function buildKeywords() {
  const words = new Set();
  const add = (s) => {
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .forEach((w) => words.add(w));
  };
  try {
    const d = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
    const axes = Array.isArray(d) ? d : d.axes ? d.axes : Object.values(d);
    for (const ax of axes) {
      add(ax.label);
      add(ax.left_pole);
      add(ax.right_pole);
      (ax.topics || []).forEach(add);
    }
  } catch (e) {
    log(`could not read ontology: ${e.message}`);
  }
  try { add(fs.readFileSync(VOCATION, "utf-8").slice(0, 2000)); } catch {}
  return words;
}

function scorePost(text, keywords) {
  const toks = new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
  );
  let hits = 0;
  const matched = [];
  for (const t of toks) {
    if (keywords.has(t)) { hits++; matched.push(t); }
  }
  return { hits, matched: matched.slice(0, 8) };
}

// ── Comment generation (on-voice, via Gemini) ────────────────────────────────
async function generateComment(post) {
  const { callVertex } = require("./vertex");
  let vocation = "";
  try { vocation = fs.readFileSync(VOCATION, "utf-8").slice(0, 1500); } catch {}
  const prompt =
`You are Sebastian Hunter writing a LinkedIn comment. Your vocation and voice:
${vocation}

You are commenting on this LinkedIn post by ${post.author}:
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
    return text;
  } catch (err) {
    log(`comment generation failed: ${err.message}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  let tab;
  try {
    tab = await li.ensureTab();
    if (!(await li.sessionOk(tab))) {
      log("LinkedIn session not present (no li_at cookie) — is HelmStack logged in?");
      process.exit(0);
    }
  } catch (err) {
    log(`could not reach HelmStack/LinkedIn: ${err.message}`);
    process.exit(0);
  }

  const keywords = buildKeywords();
  log(`relevance vocabulary: ${keywords.size} terms`);

  let posts;
  try {
    posts = await li.scrapeFeed(tab, { limit: 12, tag });
  } catch (err) {
    log(`feed scrape failed: ${err.message}`);
    process.exit(0);
  }
  log(`scraped ${posts.length} feed post(s)`);

  const ledger = loadLedger();
  const seen = new Set(ledger.keys);

  // Score + rank
  const ranked = posts
    .map((p) => ({ ...p, key: postKey(p), score: scorePost(p.text, keywords) }))
    .filter((p) => !seen.has(p.key))
    .filter((p) => p.score.hits >= RELEVANCE_MIN)
    .sort((a, b) => b.score.hits - a.score.hits);

  log(`${ranked.length} relevant, un-engaged post(s) (min ${RELEVANCE_MIN} hits)`);
  if (ranked.length === 0) {
    log("nothing to engage this cycle");
    process.exit(0);
  }

  // ── Likes ──────────────────────────────────────────────────────────────────
  let likes = 0;
  for (const p of ranked.slice(0, MAX_LIKES)) {
    if (p.liked) { seen.add(p.key); continue; }
    const ok = await li.likeByIdx(tab, p.idx, { dryRun: DRY_RUN });
    if (ok) {
      likes++;
      seen.add(p.key);
      log(`${DRY_RUN ? "[dry] " : ""}liked @${p.author} (hits=${p.score.hits}: ${p.score.matched.join(",")})`);
      if (!DRY_RUN) {
        logLinkedIn({ type: "linkedin_like", target_author: p.author, target_url: p.permalink, cycle: CYCLE });
      }
    } else {
      log(`like failed for @${p.author}`);
    }
  }

  // ── Comment (top post only, capped) ──────────────────────────────────────────
  let comments = 0;
  for (const p of ranked.slice(0, MAX_COMMENTS)) {
    const text = await generateComment(p);
    if (!text) { log(`no comment generated for @${p.author}`); continue; }
    const vfErrors = voiceFilter.check(text);
    if (vfErrors.length > 0) { log(`comment voice_filter rejected: ${vfErrors.join("; ")}`); continue; }

    const res = await li.commentByIdx(tab, p.idx, text, { dryRun: DRY_RUN, tag });
    if (res.dryRun) {
      log(`[dry] would comment on @${p.author}: "${text.slice(0, 70)}..."`);
      comments++;
      continue;
    }
    if (res.ok) {
      comments++;
      seen.add(p.key);
      log(`commented on @${p.author}: "${text.slice(0, 70)}..."`);
      logLinkedIn({ type: "linkedin_comment", content: text, target_author: p.author, target_url: p.permalink, cycle: CYCLE });
    } else {
      log(`comment failed for @${p.author} (${res.reason})`);
    }
  }

  ledger.keys = [...seen];
  saveLedger(ledger);
  log(`done — ${likes} like(s), ${comments} comment(s)${DRY_RUN ? " (dry run)" : ""}`);
  process.exit(0);
})().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(0);
});
