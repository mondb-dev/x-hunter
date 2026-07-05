#!/usr/bin/env node
/**
 * runner/x_engage.js — hunter adapter: X feed engagement over HelmStack.
 *
 * Mirrors linkedin_engage.js. Wires hunter's brain into the generic
 * `helmstack-social` X engine (tools/helmstack-social): belief-axis relevance
 * scoring, satire/sensitive-content guards, on-voice reply generation (Gemini)
 * with a fact-check pass, likes + replies, and interaction logging.
 *
 * This is the HelmStack path — parallel to the legacy-CDP proactive_reply.js,
 * which still runs against the :18801 Chrome. Opt in by invoking this script.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1,
 *      X_MAX_LIKES (3), X_MAX_REPLIES (1), X_RELEVANCE_MIN (1).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { HelmStackClient, X } = require("../tools/helmstack-social/src");
const { isXSuppressed } = require("./lib/x_control");

const ROOT = path.resolve(__dirname, "..");
const ONTOLOGY = path.join(ROOT, "state", "ontology.json");
const LEDGER = path.join(ROOT, "state", "x_engaged.json");
const INTERACTIONS = path.join(ROOT, "state", "interactions.json");

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX_LIKES = Number.parseInt(process.env.X_MAX_LIKES || "3", 10);
const MAX_REPLIES = Number.parseInt(process.env.X_MAX_REPLIES || "1", 10);
const RELEVANCE_MIN = Number.parseInt(process.env.X_RELEVANCE_MIN || "1", 10);
const OWN_HANDLE = "SebastianHunts";
const tag = "x_engage";
const log = (m) => console.log(`[${tag}] ${m}`);

// ── Ledger + interaction logging ────────────────────────────────────────────
function loadLedger() { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, "utf-8")).keys); } catch { return new Set(); } }
function saveLedger(seen) { try { fs.writeFileSync(LEDGER, JSON.stringify({ keys: [...seen].slice(-500) }, null, 2)); } catch {} }
function logInteraction(entry) {
  try {
    const data = JSON.parse(fs.readFileSync(INTERACTIONS, "utf-8"));
    (data.interactions = data.interactions || []).push({ ...entry, timestamp: new Date().toISOString() });
    fs.writeFileSync(INTERACTIONS, JSON.stringify(data, null, 2));
  } catch {}
}

// ── Content guards (ported from proactive_reply) ────────────────────────────
function isSensitiveContent(text) {
  const t = text.toLowerCase();
  if (/\b(rape|child rape|sexual assault|molest|paedophile|pedophile|child abuse|grooming)\b/.test(t)) return true;
  if (/\b(trafficking|sex trafficking|epstein|diddy)\b/.test(t)) return true;
  if (/\b(killed|murdered|assassinated)\b.{0,40}\b(president|minister|senator|governor|mayor)\b/i.test(t)) return true;
  if (/\b(president|minister|senator|governor|mayor)\b.{0,40}\b(killed|murdered|assassinated)\b/i.test(t)) return true;
  return false;
}
function isSatireOrJoke(text) {
  const t = text.toLowerCase();
  if (/\b(satire|parody|irony|ironic|sarcasm|sarcastic|just kidding|jk|lmao|lmfao|lol)\b/.test(t)) return true;
  if (/^(why did|what do you call|knock knock|fun fact:|hot take:|unpopular opinion:)/i.test(text)) return true;
  if (/😂|🤣|💀|😭/.test(text) || /\/s\b/.test(t)) return true;
  const emoji = (text.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
  return emoji >= 4 && text.length < 80;
}

// ── Axis relevance scoring ───────────────────────────────────────────────────
function loadAxisKeywords() {
  try {
    const o = JSON.parse(fs.readFileSync(ONTOLOGY, "utf-8"));
    const axes = (o.axes || []).filter((a) => (a.confidence || 0) >= 0.7).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
    const kw = [];
    for (const a of axes) (a.label + " " + a.left_pole + " " + a.right_pole).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4).forEach((w) => kw.push(w));
    return [...new Set(kw)];
  } catch { return []; }
}
function makeScorer(keywords) {
  return (post) => {
    const text = post.text || "";
    if (isSensitiveContent(text) || isSatireOrJoke(text)) return -1; // hard-skip
    const lower = text.toLowerCase();
    let hits = 0;
    for (const kw of keywords) if (lower.includes(kw)) hits++;
    return hits;
  };
}

// ── On-voice reply generation (Gemini + fact-check) ──────────────────────────
async function generateReply(post) {
  const { callVertex } = require("./vertex");
  let persona = "";
  try {
    const { buildPersona, buildCoreContext } = require("./lib/sebastian_respond");
    persona = buildPersona("reply") + "\n\n" + buildCoreContext({ maxAxes: 8, journalCount: 2, journalChars: 400, includeClaims: true });
  } catch { persona = "You are Sebastian Hunter, mapping narratives in public discourse. Direct, specific, evidence-first."; }

  const prompt = persona +
    `\n\nCURRENT DATE: ${new Date().toISOString().slice(0, 10)}. Do not rely on training data for current officeholders.\n` +
    `\nYou are proactively replying to a post on X (outbound — nobody asked you). Insert Sebastian's voice into the conversation with a specific, substantive point.\n` +
    `\nThe post by @${post.handle}:\n"${(post.text || "").slice(0, 600)}"\n\n` +
    `Draft a reply (max 260 chars) that: names a specific fact/party/number; is direct and confident (no "interesting point", no hedging); does not start with "I"; sounds like a sharp person, not a bot. If the post is satire/joke/not a sincere claim, or you cannot add something genuinely worth saying, return SKIP.\n\nReturn ONLY the reply text.`;

  try {
    const raw = await callVertex(prompt, 400, { model: "gemini-2.5-flash", thinkingBudget: 0 });
    let text = (raw || "").trim().replace(/^["']|["']$/g, "");
    if (!text || text === "SKIP" || text.length > 270) return null;

    // Fact-check pass for stale officeholder/date claims
    const fc = await callVertex(
      `Today is ${new Date().toISOString().slice(0, 10)}. Review this X reply for verifiably wrong facts (wrong current officeholder titles, datable facts clearly wrong given today). Reply JSON only: {"pass":true} or {"pass":false,"corrected":"fixed text or null"}.\n\nDRAFT:\n"${text}"`,
      300, { model: "gemini-2.5-flash", thinkingBudget: 0 }
    ).catch(() => '{"pass":true}');
    try {
      const m = fc.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").match(/\{[\s\S]*?\}/);
      const res = m ? JSON.parse(m[0]) : { pass: true };
      if (res.pass === false) {
        if (res.corrected && res.corrected.length <= 270) text = res.corrected;
        else return null;
      }
    } catch { /* unparseable = let through */ }
    return text;
  } catch (err) { log(`reply generation failed: ${err.message}`); return null; }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (isXSuppressed("reply")) { log("X reply suppression active — skipping"); process.exit(0); }

  const x = new X(new HelmStackClient(), { ownHandle: OWN_HANDLE, log });
  try {
    await x.ensureTab();
    if (!(await x.sessionOk())) { log("X session not present (no auth_token/ct0) — is HelmStack logged in?"); process.exit(0); }
  } catch (err) { log(`could not reach HelmStack/X: ${err.message}`); process.exit(0); }

  const keywords = loadAxisKeywords();
  log(`relevance vocabulary: ${keywords.length} terms`);
  const seen = loadLedger();

  const result = await x.engage({
    score: makeScorer(keywords),
    generateReply,
    onLike: async (p) => logInteraction({ type: "x_like", tweet_url: p.url, handle: p.handle, cycle: CYCLE }),
    onReply: async (p, text) => logInteraction({ type: "x_reply", tweet_url: p.url, handle: p.handle, our_reply: text, cycle: CYCLE }),
    seen,
    minScore: RELEVANCE_MIN,
    maxLikes: MAX_LIKES,
    maxReplies: MAX_REPLIES,
    dryRun: DRY_RUN,
  });

  if (!DRY_RUN) saveLedger(seen); // dry-runs must not mark posts as engaged
  log(`done — ${result.likes} like(s), ${result.replies} reply(ies)${DRY_RUN ? " (dry run)" : ""}`);
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
