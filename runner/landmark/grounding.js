/**
 * runner/landmark/grounding.js — pre-publish factual grounding gate
 *
 * A landmark editorial is allowed to ANALYZE the discourse pattern it observed,
 * but it must NOT assert real-world events, incidents, actions, or outcomes as
 * fact unless those are actually present in the source posts.
 *
 * This is the check that catches fabrication like "Iran Halts Indian Flotilla
 * in Hormuz" — a confident real-world event invented from a handful of jokes
 * and memes. The structural validator (validateEditorialForMint) cannot catch
 * this because the fabricated article still cites real contributors and the
 * detected keywords; only a content-vs-source comparison can.
 *
 * Runs BEFORE publication (unlike critique.js, which runs after). Uses
 * Gemini Flash via Vertex AI (runner/llm.js).
 *
 * Fails CLOSED: if the model is unavailable or the response is unparseable,
 * grounding is treated as NOT confirmed and publication is blocked. Landmark
 * detection re-runs on the next scan, so a transient failure only delays — it
 * never lets an unverified editorial through.
 */

"use strict";

const { generate: llmGenerate } = require("../llm");

function buildGroundingPrompt(event, content) {
  const sampleTexts = (event.samplePosts || [])
    .map(p => `@${p.username}: "${p.text}"`)
    .join("\n") || "(no source posts available)";

  return `You are a strict fact-grounding auditor. You are reviewing an editorial written by an autonomous agent about a spike in X/Twitter discourse, BEFORE it is published.

The editorial is ONLY allowed to:
- Analyze the discourse pattern (what accounts are saying, how clusters are reacting, what narratives are competing).
- Quote or paraphrase the source posts below.
- Describe what posts *claim* using hedged language ("posts claim...", "accounts are discussing...").

The editorial is NOT allowed to assert, as established fact, any real-world event, incident, military/naval/political action, casualty, outcome, or causal attribution that does NOT appear in the source posts. Inventing a concrete event from vague or joking posts is a fabrication.

## Source posts (the ONLY ground truth)
${sampleTexts}

## Editorial under review
HEADLINE: ${content.headline}
LEAD: ${content.lead}

EDITORIAL:
${content.editorial}

---

List every concrete real-world factual claim in the editorial that is asserted as fact but is NOT supported by the source posts. Do NOT flag: analysis of the discourse itself, characterizations of how accounts are reacting, hedged language, or direct quotes of the posts.

Respond in EXACTLY this format, nothing else:

VERDICT: GROUNDED or UNGROUNDED
FABRICATIONS:
- <one fabricated claim per line, or the single word "none">
REASON: <one sentence explaining the verdict>`;
}

function parseVerdict(raw) {
  const m = raw.match(/VERDICT:\s*(GROUNDED|UNGROUNDED)/i);
  return m ? m[1].toUpperCase() : null;
}

function parseFabrications(raw) {
  const m = raw.match(/FABRICATIONS:\s*([\s\S]*?)(?:\nREASON:|$)/i);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map(l => l.replace(/^[-*\s]+/, "").trim())
    .filter(Boolean)
    .filter(l => l.toLowerCase() !== "none");
}

function parseReason(raw) {
  const m = raw.match(/REASON:\s*(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : null;
}

/**
 * Check whether an editorial's factual claims are grounded in the source posts.
 *
 * @param {object} event   - landmark event (must include samplePosts)
 * @param {object} content - { headline, lead, editorial }
 * @returns {Promise<{grounded: boolean, verdict: string|null, fabrications: string[], reason: string|null, raw: string|null}>}
 */
async function checkGrounding(event, content) {
  const prompt = buildGroundingPrompt(event, content);

  let raw;
  try {
    raw = await llmGenerate(prompt, { temperature: 0.0, maxTokens: 500, timeoutMs: 60_000 });
  } catch (err) {
    console.warn(`[grounding] LLM call failed: ${err.message} — failing closed (blocking publish)`);
    return { grounded: false, verdict: null, fabrications: [], reason: `grounding check unavailable: ${err.message}`, raw: null };
  }

  if (!raw || raw.length < 10) {
    console.warn("[grounding] empty response — failing closed (blocking publish)");
    return { grounded: false, verdict: null, fabrications: [], reason: "empty grounding response", raw: raw || null };
  }

  const verdict = parseVerdict(raw);
  const fabrications = parseFabrications(raw);
  const reason = parseReason(raw);

  // Grounded only if the model explicitly says GROUNDED and lists no fabrications.
  const grounded = verdict === "GROUNDED" && fabrications.length === 0;

  if (!grounded && !verdict) {
    console.warn("[grounding] could not parse verdict — failing closed (blocking publish)");
  }

  return { grounded, verdict, fabrications, reason, raw };
}

module.exports = { checkGrounding, buildGroundingPrompt };
