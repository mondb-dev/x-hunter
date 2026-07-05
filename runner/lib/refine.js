#!/usr/bin/env node
/**
 * runner/lib/refine.js — layered discourse refinement for Sebastian's output.
 *
 * A single, globally-callable primitive that takes a draft (a tweet, thread,
 * reply, LinkedIn comment, journal paragraph, article section…) and runs it
 * through a critique → revise loop before it ships. The point is to catch the
 * "dumb inferences" a small local model (qwen2.5-agent) makes — two unrelated
 * ideas welded together, vague platitudes, unfalsifiable filler — WITHOUT a
 * cloud model. All judgment is local; we compensate for model size with
 * structure (tight rubric, multiple lenses, revision) rather than a bigger brain.
 *
 * Design goals (per user):
 *   - Globally accessible: require('./lib/refine') anywhere.
 *   - Recursive: refine() can spawn INNER refinements (e.g. each tweet in a
 *     thread refined on its own, then the assembled thread refined as a whole).
 *   - Grounded: can pull related memory via recall() and fact-check via verify.
 *   - Fully local: uses llm.generate → qwen; no Vertex.
 *
 * Return shape:
 *   { text, verdict: 'pass'|'revised'|'reject', rounds, issues[], checks, parts? }
 *   verdict semantics:
 *     pass    — ship as-is
 *     revised — ship the (rewritten) `text`; it was improved
 *     reject  — do NOT ship; `issues` says why
 *
 * Callers decide what to do with a reject (skip this cycle, regenerate, etc.).
 */

"use strict";

const { generate } = require("../llm");

// recall (embeddings DB) and verify (web search, ~90s) are both optional and
// carry heavy transitive deps — lazy-require so refine() loads and runs even
// where those subsystems are absent, and stays cheap when they're not used.
function getRecallText() {
  try { return require("./recall").recallText; } catch { return null; }
}
function getVerify() {
  try { return require("./verify_claim").verifyClaim; } catch { return null; }
}

// ── JSON extraction from a noisy local-model response ────────────────────────
// Small local models append junk after the JSON and mis-escape strings, so we
// (1) scan for the first balanced-brace object, then (2) fall back to pulling
// the verdict + numeric scores out with regexes. The gate must degrade to a
// real verdict, never silently to "pass".
function extractBalanced(s) {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function parseCritique(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/```[a-z]*/gi, "").trim();
  const obj = extractBalanced(cleaned);
  if (obj) {
    try { return JSON.parse(obj); } catch { /* fall through to regex */ }
  }
  // Regex fallback — recover verdict + scores even from malformed JSON.
  const verdict = (cleaned.match(/"?verdict"?\s*[:=]\s*"?(PASS|REVISE|REJECT)/i) || [])[1];
  if (!verdict) return null;
  const num = (k) => {
    const m = cleaned.match(new RegExp(`"?${k}"?\\s*[:=]\\s*(\\d)`, "i"));
    return m ? Number(m[1]) : undefined;
  };
  const reason = (cleaned.match(/"?reason"?\s*[:=]\s*"([^"]{0,200})/i) || [])[1] || "";
  return {
    verdict: verdict.toUpperCase(),
    coherence: num("coherence"),
    one_topic: num("one_topic"),
    specificity: num("specificity"),
    falsifiability: num("falsifiability"),
    reason,
  };
}

function textOf(draft) {
  if (typeof draft === "string") return draft;
  if (draft && typeof draft === "object") return draft.text || draft.content || JSON.stringify(draft);
  return String(draft ?? "");
}

// ── Rubric ───────────────────────────────────────────────────────────────────
// Kept deliberately tight. We bias toward REVISE (fixable) over REJECT so the
// gate doesn't become the over-eager SKIP problem it's meant to help with.
// REJECT is reserved for structural failure: incoherence or two-unrelated-ideas.
function buildCritiquePrompt({ text, surface, goal, grounding, minSpecificity }) {
  return (
`You are a strict internal editor for Sebastian Hunter, who maps narrative construction in public discourse. His voice is direct, specific, evidence-first — never vague, never two unrelated ideas jammed together.

Evaluate this ${surface} draft. Be honest; most drafts have a real flaw.

DRAFT:
"""
${text}
"""
${goal ? `\nWHAT IT SHOULD DO: ${goal}\n` : ""}${grounding ? `\nWHAT SEBASTIAN ALREADY KNOWS (grounding — the draft should be consistent with this):\n${grounding}\n` : ""}
Score each 0-5:
- coherence: Does it hold together as ONE thought? A draft that welds two unrelated topics with "yet"/"and"/"but" (e.g. a religion claim next to an unrelated food joke) scores 0-1.
- one_topic: A single subject/argument, not a grab-bag? 0-1 if it lists unrelated items.
- specificity: Names a concrete account, claim, statistic, or event? Generic musings about "institutions"/"narratives" score 0-1.
- falsifiability: Could a thoughtful person disagree? Platitudes score 0-1.

Verdict rules:
- "REJECT" ONLY for structural failure: coherence<=1 OR one_topic<=1 OR specificity<${minSpecificity}.
- "REVISE" if the core idea is sound but the wording is weak, vague, or off-voice.
- "PASS" if already good.

Reply with ONE line of JSON, no other text, keep "reason" under 15 words with no quotation marks:
{"coherence":N,"one_topic":N,"specificity":N,"falsifiability":N,"verdict":"PASS|REVISE|REJECT","reason":"..."}`
  );
}

function buildRevisePrompt({ text, surface, goal, grounding, reason }) {
  return (
`Rewrite this ${surface} in Sebastian Hunter's voice: direct, specific, evidence-first, ONE clear point. Keep it roughly the same length. Do NOT weld in unrelated topics.
${goal ? `Goal: ${goal}\n` : ""}${reason ? `Fix this problem: ${reason}\n` : ""}${grounding ? `Stay consistent with:\n${grounding}\n` : ""}
Original:
"""
${text}
"""

Output ONLY the rewritten ${surface} text — no preamble, no quotes, no explanation.`
  );
}

/**
 * refine(draft, opts) — see file header.
 *
 * @param {string|object} draft
 * @param {object} [opts]
 * @param {string}  [opts.surface='text']   label used in the rubric ("tweet","thread","reply","comment","journal","article")
 * @param {string}  [opts.goal]             one-line description of what the text should accomplish
 * @param {string}  [opts.context]          extra grounding text to append verbatim
 * @param {number}  [opts.maxRounds=2]      critique→revise iterations
 * @param {number}  [opts.depth=0]          current recursion depth (internal)
 * @param {number}  [opts.maxDepth=2]       recursion guard
 * @param {Array}   [opts.parts]            sub-drafts to refine first (inner refinement)
 * @param {Function}[opts.reassemble]       (refinedParts:string[]) => string ; required with parts
 * @param {boolean} [opts.useRecall=true]   pull related memory to ground the critique
 * @param {string}  [opts.recallQuery]      override recall query (defaults to draft text)
 * @param {boolean} [opts.revise=false]     attempt an LLM rewrite on REVISE verdicts (off by default — a small local model can garble the rewrite; the reject path is the real guard)
 * @param {boolean} [opts.useVerify=false]  fact-check the central claim via verify_claim
 * @param {string}  [opts.verifyClaim]      the specific claim string to verify (defaults to draft text)
 * @param {number}  [opts.minSpecificity=2]
 * @param {Function}[opts.llm=generate]     injectable llm (prompt,opts)=>Promise<string>
 * @param {Function}[opts.log]              logger
 * @returns {Promise<{text,verdict,rounds,issues,checks,parts?}>}
 */
async function refine(draft, opts = {}) {
  const {
    surface = "text",
    goal = "",
    context = "",
    maxRounds = 2,
    depth = 0,
    maxDepth = 2,
    parts = null,
    reassemble = null,
    useRecall = true,
    recallQuery = null,
    revise = false,
    useVerify = false,
    verifyClaim: claimToVerify = null,
    minSpecificity = 2,
    llm = generate,
    log = () => {},
  } = opts;

  const pad = "  ".repeat(depth);

  // ── Inner refinement: refine each part, then the assembled whole ───────────
  let refinedParts = null;
  if (Array.isArray(parts) && parts.length && depth < maxDepth) {
    refinedParts = [];
    for (let i = 0; i < parts.length; i++) {
      log(`${pad}[refine] part ${i + 1}/${parts.length} (${surface})`);
      const r = await refine(parts[i], {
        ...opts,
        parts: null,
        reassemble: null,
        depth: depth + 1,
        // parts are components — a single tweet in a thread needn't stand alone
        // as a full falsifiable argument, so relax specificity one notch.
        minSpecificity: Math.max(1, minSpecificity - 1),
        useVerify: false, // verify once at the whole-draft level, not per-part
      });
      refinedParts.push(r);
      // A structurally-broken part sinks the whole thing.
      if (r.verdict === "reject") {
        return {
          text: null,
          verdict: "reject",
          rounds: 0,
          issues: [`part ${i + 1}: ${(r.issues || []).join("; ") || "rejected"}`],
          checks: null,
          parts: refinedParts,
        };
      }
    }
  }

  // Text we critique at THIS level (the reassembled whole, if we have parts).
  let working;
  if (refinedParts) {
    const partTexts = refinedParts.map((r) => r.text);
    working = reassemble ? reassemble(partTexts) : partTexts.join("\n\n");
  } else {
    working = textOf(draft);
  }

  if (!working || !working.trim()) {
    return { text: null, verdict: "reject", rounds: 0, issues: ["empty draft"], checks: null, parts: refinedParts || undefined };
  }

  // ── Grounding ──────────────────────────────────────────────────────────────
  let grounding = context || "";
  if (useRecall) {
    const recallText = getRecallText();
    if (recallText) {
      try {
        const mem = await recallText(recallQuery || working, { limit: 4, maxChars: 800 });
        if (mem) grounding = grounding ? `${grounding}\n${mem}` : mem;
      } catch { /* recall is best-effort */ }
    }
  }

  // ── Critique → revise loop ─────────────────────────────────────────────────
  let text = working;
  let lastChecks = null;
  let issues = [];
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    let critique;
    try {
      const raw = await llm(
        buildCritiquePrompt({ text, surface, goal, grounding, minSpecificity }),
        { temperature: 0.0, maxTokens: 200, timeoutMs: 90_000 }
      );
      critique = parseCritique(raw);
    } catch (e) {
      // LLM outage: fail OPEN so an Ollama hiccup doesn't block the whole
      // pipeline. (A warm model answers in ~4s, so this is rare.)
      log(`${pad}[refine] critique llm failed: ${e.message} — passing through unrefined`);
      return { text, verdict: "pass", rounds, issues: ["critique unavailable"], checks: null, parts: refinedParts || undefined };
    }

    if (!critique || !critique.verdict) {
      // Could not recover a verdict even via regex. For a quality gate this is
      // treated as pass-through (the model responded, just unusably) rather
      // than a hard block — but it's logged so it's visible.
      log(`${pad}[refine] unparseable critique — passing through`);
      return { text, verdict: "pass", rounds, issues: ["critique unparseable"], checks: null, parts: refinedParts || undefined };
    }

    lastChecks = critique;
    issues = critique.reason ? [critique.reason] : [];
    const verdict = String(critique.verdict).toUpperCase();

    if (verdict === "PASS") break;

    if (verdict === "REJECT") {
      log(`${pad}[refine] REJECT (${surface}): ${critique.reason || "structural"}`);
      return { text, verdict: "reject", rounds, issues, checks: lastChecks, parts: refinedParts || undefined };
    }

    // REVISE. Auto-rewriting with a small local model can *introduce* errors
    // (garbled words, drift), so it's opt-in. With revise off we ship the
    // original — the reject path is the real protection; polish is optional.
    if (!revise) {
      log(`${pad}[refine] revise suggested (${critique.reason || ""}) — revise disabled, shipping original`);
      break;
    }
    // Second call, plain-text rewrite (decoupled from the fragile JSON).
    if (round < maxRounds - 1) {
      try {
        const rewrite = await llm(
          buildRevisePrompt({ text, surface, goal, grounding, reason: critique.reason }),
          { temperature: 0.3, maxTokens: 400, timeoutMs: 90_000 }
        );
        const cleaned = String(rewrite || "").replace(/^["'\s]+|["'\s]+$/g, "").trim();
        if (cleaned && cleaned !== text.trim()) {
          log(`${pad}[refine] revise round ${rounds}: ${critique.reason || ""}`);
          text = cleaned;
          continue; // re-critique the rewrite
        }
      } catch (e) {
        log(`${pad}[refine] revise llm failed: ${e.message} — shipping current`);
      }
    }
    // No usable rewrite (or out of rounds) → ship what we have.
    break;
  }

  // ── Optional fact-check of the central claim ───────────────────────────────
  if (useVerify) {
    const verifyClaim = getVerify();
    if (verifyClaim) {
      const claim = claimToVerify || text;
      try {
        const v = verifyClaim({ claim: claim.slice(0, 400) });
        if (v && typeof v.status === "string") {
          lastChecks = { ...(lastChecks || {}), verification: { status: v.status, confidence: v.confidence } };
          const refuted = /refut|false|contradict/i.test(v.status) && (v.confidence ?? 0) >= 0.6;
          if (refuted) {
            log(`${pad}[refine] REJECT: central claim refuted (${v.status} ${v.confidence})`);
            return { text, verdict: "reject", rounds, issues: [...issues, `claim refuted: ${v.status}`], checks: lastChecks, parts: refinedParts || undefined };
          }
        }
      } catch { /* verification best-effort */ }
    }
  }

  const changed = text.trim() !== working.trim();
  return {
    text,
    verdict: changed ? "revised" : "pass",
    rounds,
    issues,
    checks: lastChecks,
    parts: refinedParts || undefined,
  };
}

module.exports = { refine };
