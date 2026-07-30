#!/usr/bin/env node
/**
 * runner/llm.js — shared text-generation + embedding helper
 *
 * Exports:
 *   generate(prompt, opts)  → Promise<string>       text response
 *   embed(text)             → Promise<null>         DISABLED — see below
 *   cosineSimilarity(a, b)  → number in [-1, 1]
 *   topK(queryVec, entries, k) → sorted entries with .similarity
 *
 * INFERENCE POLICY: Claude is the only LLM. generate() routes to lib/compose.js
 * and throws if Claude is unavailable — no local model, no Vertex, no Gemini.
 *
 * EMBEDDINGS ARE DISABLED. Claude exposes no embedding endpoint, and the policy
 * admits no second provider, so embed() returns null unconditionally. Callers
 * already treat null as "no vector" and degrade to keyword search (recall.js
 * falls back to sqlite fts5), so this is a quality regression, not a breakage.
 * The stored vectors in state/ are now inert: they are in the nomic-embed-text
 * model space and nothing will produce new ones to compare against. Re-enabling
 * semantic recall means picking an embedding provider and running
 * backfill_embeddings.js to re-embed the corpus into one consistent space.
 */

"use strict";

/**
 * Generate text via Claude. Retries transient failures inside compose(), then
 * throws — there is no fallback backend by policy.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.temperature=0.2]  accepted; no CLI equivalent
 * @param {number} [opts.maxTokens=350]    accepted; no CLI equivalent
 * @param {number} [opts.timeoutMs=60000]  per-attempt kill timeout
 * @returns {Promise<string>} trimmed text response
 */
async function generate(prompt, opts = {}) {
  const { timeoutMs = 60_000, tag = "llm" } = opts;

  const { compose } = require("./lib/compose");
  const out = await compose(prompt, { timeoutMs, tag });
  const text = String(out || "").trim();
  if (!text) throw new Error("[llm] Claude returned empty text");
  return text;
}

/**
 * Embeddings are disabled under the Claude-only policy — Claude has no
 * embedding endpoint. Always returns null; callers degrade to keyword search.
 * See the module header for what re-enabling would involve.
 */
async function embed(_text) {
  return null;
}

/**
 * Cosine similarity between two equal-length vectors.
 */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Return top-k entries sorted by descending cosine similarity to queryVec.
 * entries: [{entity_id, vector, ...}]
 */
function topK(queryVec, entries, k = 5) {
  if (!queryVec || entries.length === 0) return [];
  return entries
    .map(e => ({ ...e, similarity: cosineSimilarity(queryVec, e.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

module.exports = { generate, embed, cosineSimilarity, topK };
