"use strict";
/**
 * runner/lib/model_routing.js — which Claude model answers which call.
 *
 * Everything ran on one model (sonnet) regardless of what the call was doing.
 * Most calls are not reasoning work: they score a feed item for relevance,
 * check a claim, validate that a piece of evidence really supports the pole it
 * was filed against, or pick one label from a fixed list. Those are Haiku work.
 * A solution brief's draft and red-team are the opposite — that is where the
 * quality actually matters, and they already run on Opus.
 *
 * Measured 2026-08-30..09-06 (state/cost_ledger.jsonl): ~1,474 calls/day, of
 * which the mechanical ones dominate by count while carrying small prompts.
 *
 * ON A SUBSCRIPTION this does not save dollars — it saves QUOTA. Usage limits
 * are consumption-weighted, so moving high-volume mechanical calls off the
 * reasoning model is what keeps the foundation phase from exhausting the plan.
 * (The 50% Batch API discount does NOT apply here: `claude -p` is a CLI
 * subprocess against the subscription, and there is no batch endpoint behind it.
 * That lever only exists if the operator moves to API billing.)
 *
 * Routing is by call TAG — every call already carries one (llm.js callerTag()
 * tags untagged callers `llm:<file>`). Explicit opts.claudeModel always wins,
 * so a caller that knows what it needs is never overridden.
 *
 * MODEL_ROUTING=off disables routing entirely (everything back to the default).
 */

const DEFAULT_MODEL = "sonnet";

/**
 * Mechanical work: classification, scoring, validation, label-picking. Small
 * prompts, high volume, no long-horizon reasoning. A wrong answer here is
 * caught by the gate above it, not shipped.
 */
const HAIKU_TAGS = [
  "factcheck",             // tweet:factcheck, quote:factcheck, x_reply:factcheck
  "coherence",             // x_reply:coherence
  "relevance",             // llm:content_relevance — per-feed-item scoring
  "llm:content_relevance",
  "llm:apply_ontology_delta", // stance validation, one call per evidence entry
  "stance_check",
  "llm:voice_filter",
  "llm:comment_candidates",
  "llm:discourse_scan",
  "llm:linkedin_engage",   // scores every candidate post in the feed
  "llm:fb_collect",
  "dr-pick",               // deep research: pick the next node
  "dr-gap",                // deep research: name the gap
  ":judge",                // experiment:<id>:judge
  ":code",                 // experiment:<id>:code — document coding
];

/**
 * Where quality is the product. Kept explicit so a future tag cannot silently
 * inherit Opus by accident.
 */
const OPUS_TAGS = ["solution:draft", "solution:review", "solution:revise"];

function envModel(name, fallback) {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

/**
 * @param {string} tag  the cost-meter tag for this call
 * @returns {string|null} model alias, or null to leave the default alone
 */
function routeModel(tag) {
  if (String(process.env.MODEL_ROUTING || "").toLowerCase() === "off") return null;
  const t = String(tag || "").toLowerCase();
  if (!t) return null;
  if (OPUS_TAGS.some((x) => t === x || t.startsWith(x))) return envModel("CLAUDE_QUALITY_MODEL", "opus");
  if (HAIKU_TAGS.some((x) => t === x || t.includes(x))) return envModel("CLAUDE_CHEAP_MODEL", "haiku");
  return null;
}

module.exports = { routeModel, HAIKU_TAGS, OPUS_TAGS, DEFAULT_MODEL };
