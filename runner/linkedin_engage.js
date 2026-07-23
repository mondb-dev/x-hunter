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
const { passOutbound } = require("./lib/outbound_gates");

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

// ── Content guards (parity with x_engage) ───────────────────────────────────────
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
  if (/😂|🤣|💀|😭/.test(text) || /\/s\b/.test(t)) return true;
  return false;
}

// ── LLM relevance scoring (0-3) — parity with x_engage ──────────────────────────
// Was keyword-hit counting against axis vocabulary (scored ~everything low); a
// small local model judges topical relevance far more robustly. Scoring stays on
// the local brain (cheap); composition uses Claude.
function makeScorer() {
  const { generate: llmGenerate } = require("./llm");
  return async (post) => {
    const text = (post.text || "").trim();
    if (!text) return -1;
    if (isSensitiveContent(text) || isSatireOrJoke(text)) return -1; // hard-skip
    try {
      const raw = await llmGenerate(
        `You rate LinkedIn posts for Sebastian Hunter, who analyzes how narratives are constructed in public discourse: political messaging, media framing, propaganda, institutional accountability, information integrity.\n\n` +
        `Rate ONLY substantive relevance to those themes. Job updates, congratulations, motivational quotes, personal milestones, generic business advice, and ads = 0 even if well-written. A post must actually engage with power, politics, media, policy, or truth-claims to score 2-3.\n\n` +
        `Answer with a SINGLE digit:\n0 = irrelevant, 1 = tangential, 2 = relevant, 3 = squarely on-topic.\n\n` +
        `POST: "${text.slice(0, 400)}"\n\nDigit:`,
        { temperature: 0, maxTokens: 5, timeoutMs: 30_000 }
      );
      const m = String(raw).match(/[0-3]/);
      return m ? Number(m[0]) : 0;
    } catch { return 0; }
  };
}

// ── On-voice comment generation (grounded + verified + gated, parity w/ X reply) ─
async function generateComment(post) {
  // Verify the post's central claim before engaging (parity with X replies):
  // skip posts whose claim can't be supported at all.
  const claim = (post.text || "").trim();
  if (claim.length > 30) {
    try {
      const { verifyClaim } = require("./lib/verify_claim");
      const v = verifyClaim({ claim, handle: post.author, url: post.permalink });
      if (v) {
        log(`verify: ${v.verdict_label || v.status} (${((v.confidence || 0) * 100).toFixed(0)}%)`);
        if (v.status === "unverified" && (v.confidence || 0) < 0.4) { log("skipping — claim too weak to engage"); return null; }
      }
    } catch (e) { log(`verify failed (${e.message}) — proceeding`); }
  }

  const { compose } = require("./lib/compose");
  // Grounding parity with X replies: persona + core context (vocation, belief
  // axes, recent claims) — not just the raw vocation blurb.
  let persona = "";
  try {
    const { buildPersona, buildCoreContext } = require("./lib/sebastian_respond");
    persona = buildPersona("reply") + "\n\n" + buildCoreContext({ maxAxes: 8, journalCount: 1, journalChars: 400, includeClaims: true });
  } catch {
    try { persona = "You are Sebastian Hunter. " + fs.readFileSync(VOCATION, "utf-8").slice(0, 800); }
    catch { persona = "You are Sebastian Hunter, mapping narratives in public discourse. Direct, specific, evidence-first."; }
  }

  const prompt = persona +
    `\n\nCURRENT DATE: ${new Date().toISOString().slice(0, 10)}. Do not rely on training data for current officeholders.\n` +
    `\nYou are writing a LinkedIn COMMENT (a professional network — analytical and credible, not an X-style hot take) on this post by ${post.author || "someone"}:\n"""\n${(post.text || "").slice(0, 1200)}\n"""\n\n` +
    `Add ONE specific, substantive point that engages a concrete claim in the post — name a fact, tension, number, or question that moves the conversation forward, consistent with your belief axes above. Professional, direct, first person; no hashtags, no emojis, no throat-clearing ("Great post!"), no internal system/tool names. 1-3 sentences, under 500 characters. If you cannot add something genuinely worth saying, return SKIP.\n\nReturn ONLY the comment text.`;

  try {
    const raw = await compose(prompt, { maxTokens: 400, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "linkedin_comment" });
    // `source` enables the coherence gate (does the comment understand the
    // post?); `regenerate` re-drafts a misread rather than dropping it.
    const gated = await passOutbound(raw, {
      gates: ["voice", "factcheck"], maxLen: 500, tag: "linkedin_comment",
      source: post.text || "",
      regenerate: async (why) => compose(
        prompt + `\n\nYOUR PREVIOUS DRAFT MISREAD THE POST — ${why}. Re-read it: get WHO did WHAT to WHOM right and do not invent a contradiction. Write a corrected comment, or return SKIP.`,
        { maxTokens: 400, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "linkedin_comment" }
      ),
    });
    if (!gated.ok) { log(`comment gate rejected: ${gated.reason}`); return null; }
    if (gated.coherence) log(`coherence flag: ${gated.coherence.why}`);
    return gated.text;
  } catch (err) { log(`comment generation failed: ${err.message}`); return null; }
}

// ── Main ────────────────────────────────────────────────────────────────────────
(async () => {
  const li = new LinkedIn(new HelmStackClient(), { ownHandleHint: "sebastian hunter", log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present (no li_at) — is HelmStack logged in?"); process.exit(0); }
  } catch (err) { log(`could not reach HelmStack/LinkedIn: ${err.message}`); process.exit(0); }

  log(`relevance scoring: LLM 0-3 (min ${RELEVANCE_MIN})`);
  const seen = loadLedger();

  const result = await li.engage({
    score: makeScorer(),
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
