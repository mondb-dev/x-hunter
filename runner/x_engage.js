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
const { loadAxisKeywords, makeScorer } = require("./lib/content_relevance");

const ROOT = path.resolve(__dirname, "..");
const LEDGER = path.join(ROOT, "state", "x_engaged.json");
const INTERACTIONS = path.join(ROOT, "state", "interactions.json");

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX_LIKES = Number.parseInt(process.env.X_MAX_LIKES || "3", 10);
const MAX_REPLIES = Number.parseInt(process.env.X_MAX_REPLIES || "1", 10);
// Scores are now a 0-3 LLM relevance rating (not keyword-hit counts), so the
// floor is 2 ("relevant") — tangential (1) and irrelevant (0) posts don't qualify.
const RELEVANCE_MIN = Number.parseInt(process.env.X_RELEVANCE_MIN || "2", 10);
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

// Content guards + axis relevance scoring live in lib/content_relevance (shared
// with x_amplify). makeScorer returns an LLM (local qwen) 0-3 relevance rating
// (+ keyword-hit tie-break); guarded content scores -1.

// Tolerant JSON extractor for the comprehension checker's output.
function extractJson(raw) {
  const m = String(raw || "").replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── Comprehension gate ───────────────────────────────────────────────────────
// Does the drafted reply actually understand what the POST says — right
// subject/object, no inverted meaning, no invented contradiction? This is the
// hole the @FoxNews miss went through: a post reporting "US soldier killed in an
// Iranian attack on a base IN Jordan" drew a reply that flipped it to "we're
// hitting Iran, why does the post say Jordan" — a total misread that the
// fact-check gate still passed because the tangential claim it made was true.
//
// Deliberately NON-BLOCKING: a fail here asks for a REGEN (see generateReply),
// not a silent drop, and the checker fails OPEN — an unparseable/errored check
// never withholds an otherwise-gated reply. So the pipeline always produces
// output; the check only steers it toward accuracy.
async function checkComprehension(postText, reply) {
  const { reason } = require("./lib/compose");
  const prompt =
`Judge ONLY whether the REPLY correctly understands what the POST actually says — not its style or whether you agree.

POST:
"${String(postText || "").slice(0, 800)}"

REPLY:
"${reply}"

FAIL it only if the reply clearly: inverts who did what to whom, invents a contradiction the post does not contain, "corrects" something the post never claimed, or is answering a different post. Agreeing, disagreeing, or adding context to the post's ACTUAL content all PASS.

Output ONLY JSON: {"understands": true, "why": "one short line"}`;
  try {
    const j = extractJson(await reason(prompt, { maxTokens: 150, tag: "x_reply_comprehension" }));
    if (!j || typeof j.understands !== "boolean") return { ok: true, why: "checker_unparseable_failopen" };
    return { ok: j.understands, why: String(j.why || "").slice(0, 160) };
  } catch (e) { return { ok: true, why: `checker_error_failopen:${e.message}` }; }
}

// ── On-voice reply generation (verify-gate + local LLM + fact-check) ─────────
async function generateReply(post) {
  // Verify the target post's central claim before engaging (ported from the
  // legacy proactive_reply CDP path). Skip posts whose claim can't be
  // supported — avoids replying into unverifiable/hallucination-prone territory.
  // Only runs for the ≤maxReplies candidate(s), so at most one verify call/run.
  const claim = (post.text || "").trim();
  if (claim.length > 30) {
    try {
      const { verifyClaim } = require("./lib/verify_claim");
      const v = verifyClaim({ claim, handle: post.handle, url: post.url });
      if (v) {
        log(`verify @${post.handle}: ${v.verdict_label || v.status} (${((v.confidence || 0) * 100).toFixed(0)}%)`);
        if (v.status === "unverified" && (v.confidence || 0) < 0.4) {
          log(`skipping @${post.handle} — claim too weak to engage`);
          return null;
        }
      }
    } catch (e) { log(`verify failed (${e.message}) — proceeding`); }
  }

  const { compose } = require("./lib/compose");
  const { passOutbound } = require("./lib/outbound_gates");
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

  // Compose → gate → comprehension-check, regenerating on a misread rather than
  // dropping. Output always goes through: a comprehension miss triggers a REGEN
  // with the specific correction, and if it's still unresolved after the retries
  // the last gated draft is posted anyway (fail-open per directive) with a loud
  // marker for review — the check steers accuracy, it never silently withholds.
  const COMPREHEND_ATTEMPTS = 2;
  let feedback = "", lastText = null;
  for (let attempt = 1; attempt <= COMPREHEND_ATTEMPTS; attempt++) {
    let raw;
    try {
      // Compose on the Claude terminal when enabled (COMPOSE_BACKEND=claude), else
      // on the local/Vertex brain. Persona/voice is carried in `prompt`.
      raw = await compose(prompt + feedback, { maxTokens: 400, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "x_reply" });
    } catch (err) { log(`reply generation failed: ${err.message}`); return null; }

    // Shared outbound gate: voice_filter (was missing on replies) + fact-check.
    const gated = await passOutbound(raw, { gates: ["voice", "factcheck"], maxLen: 270, tag: "x_reply" });
    if (!gated.ok) { log(`reply gate rejected: ${gated.reason}`); return null; }
    const text = (gated.text || "").trim();
    if (!text || text.toUpperCase() === "SKIP") return null;   // model chose not to reply
    lastText = text;

    const comp = await checkComprehension(post.text || "", text);
    if (comp.ok) return text;

    log(`comprehension miss @${post.handle} (attempt ${attempt}/${COMPREHEND_ATTEMPTS}): ${comp.why}`);
    feedback =
      `\n\nYOUR PREVIOUS DRAFT MISREAD THE POST — ${comp.why}. Re-read the post above carefully: get WHO did WHAT to WHOM and the direction of events right, and do not invent a contradiction it doesn't contain. Write a corrected reply, or return SKIP if there is nothing accurate worth adding.`;
  }
  // Directive: all output goes through — post the last draft rather than dropping,
  // but flag it clearly so a lingering misread is caught in review.
  log(`comprehension unresolved @${post.handle} after ${COMPREHEND_ATTEMPTS} attempts — posting last draft anyway (fail-open): "${(lastText || "").slice(0, 60)}"`);
  return lastText;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (isXSuppressed("reply")) { log("X reply suppression active — skipping"); process.exit(0); }

  // Dedicated tab: sharing the default x.com tab let concurrent X automations
  // (esp. collect.js's mention scrape) navigate over each other mid-flow.
  const x = new X(new HelmStackClient(), { ownHandle: OWN_HANDLE, dedicatedTab: true, log });
  try {
    await x.ensureTab();
    if (!(await x.sessionOk())) { log("X session not present (no auth_token/ct0) — is HelmStack logged in?"); await x.close().catch(() => {}); process.exit(0); }
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
  await x.close().catch(() => {});   // close the dedicated tab so tabs don't accumulate
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
