#!/usr/bin/env node
/**
 * runner/vertex.js — LOCAL brain caller (historically the Vertex/Gemini caller).
 *
 * Shared by generate_checkpoint.js, ponder.js, write_article.js, etc. The name is
 * kept so the ~35 existing callers are unchanged, but the Gemini/Vertex transport
 * is GONE: inference policy is Claude, or in its absence LOCAL — never Gemini.
 *
 * Callers reach Claude via lib/compose.js (compose()/reason()), which falls back
 * here; this module is therefore the "in its absence local" half of that policy
 * and throws rather than silently substituting a third-party model.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

"use strict";

const { useLocal, localChat } = require("./local_llm");
const costMeter = require("./lib/cost_meter");

/**
 * callVertex(prompt, maxTokens, options)
 *
 * Calls Vertex AI with the given prompt.
 * Returns the text content string.
 *
 * options.model         - model ID (default: gemini-2.5-flash)
 * options.thinkingBudget - if set and > 0, sets thinking token budget
 */
async function callVertex(prompt, maxTokens = 2000, options = {}) {
  // Local backend: route the entire non-agent brain to Ollama when OLLAMA_BASE_URL
  // points at a local server. Interface is unchanged for all ~35 callers.
  if (useLocal()) {
    const out = await localChat(prompt, {
      maxTokens,
      temperature: options.temperature ?? 0.7,
    });
    try { costMeter.record({ tag: options.tag || "brain", model: "local", promptChars: prompt.length, outChars: (out || "").length }); } catch {}
    return out;
  }

  // POLICY: inference is Claude, or in its absence LOCAL — never Gemini. The
  // Vertex/Gemini path below is retired: reaching it means the local brain is
  // not configured (OLLAMA_BASE_URL not pointing at localhost), which is a
  // misconfiguration to fix, not something to paper over with a third-party
  // model that silently changes voice and quality.
  throw new Error(
    "callVertex: no inference backend — Claude unavailable and local brain not configured " +
    `(OLLAMA_BASE_URL=${process.env.OLLAMA_BASE_URL || "unset"}). Gemini fallback is retired by policy.`
  );

}

module.exports = { callVertex };
