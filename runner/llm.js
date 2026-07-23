#!/usr/bin/env node
/**
 * runner/llm.js — shared text-generation + embedding helper
 *
 * Exports:
 *   generate(prompt, opts)  → Promise<string>       text response
 *   embed(text)             → Promise<number[]|null> 768-dim vector
 *   cosineSimilarity(a, b)  → number in [-1, 1]
 *   topK(queryVec, entries, k) → sorted entries with .similarity
 *
 * INFERENCE POLICY: generate() is Claude, or in its absence LOCAL — never
 * Gemini. The Vertex/Gemini text transport has been removed.
 *
 * EMBEDDINGS are a separate concern and still use Vertex text-embedding-004 when
 * the local embedder is unavailable: embeddings are vectors, not voice, and the
 * stored corpus must stay in ONE model space or every similarity lookup breaks.
 * Switching that is a re-embed migration (backfill_embeddings.js), not a routing
 * change.
 */

"use strict";

const { getAccessToken, getProjectConfig } = require("./gcp_auth");
const { useLocal, localChat, localEmbed } = require("./local_llm");

const EMBED_MODEL    = "text-embedding-004";

/**
 * Generate text — Claude first, local fallback.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.temperature=0.2]
 * @param {number} [opts.maxTokens=350]    maps to maxOutputTokens
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<string>} trimmed text response
 */
async function generate(prompt, opts = {}) {
  const {
    temperature = 0.2,
    maxTokens   = 350,
    timeoutMs   = 60_000,
    tag         = "llm",
    localOnly   = false,     // opt-out for hot scoring loops (see note below)
  } = opts;

  // POLICY: inference is Claude, or in its absence LOCAL — never Gemini.
  // This path previously went local-first and fell through to Vertex Gemini.
  // Going Claude-first matters most for voice/language work: the local 7B
  // (qwen2.5-agent) invents Filipino morphology — it produced the non-words
  // "atinomilaan"/"Hipotengyal"/"legalisyon" in a published tweet and dropped a
  // source attribution while rewriting. compose() handles the Claude call and
  // falls back to callVertex(), which is local-only.
  //
  // localOnly:true skips Claude for high-frequency scoring callers where a
  // per-call `claude -p` spawn would dominate cycle time.
  if (!localOnly) {
    try {
      const { compose } = require("./lib/compose");
      const out = await compose(prompt, { maxTokens, temperature, tag });
      if (out && String(out).trim()) return String(out).trim();
    } catch (e) {
      console.warn(`[llm] claude/compose failed (${e.message}) — falling back to local`);
    }
  }

  if (useLocal()) {
    return localChat(prompt, { maxTokens, temperature, timeoutMs });
  }

  throw new Error(
    `[llm] no inference backend — Claude unavailable and local brain not configured ` +
    `(OLLAMA_BASE_URL=${process.env.OLLAMA_BASE_URL || "unset"}). Gemini is retired by policy.`
  );
}

/**
 * Generate an embedding via text-embedding-004 on Vertex AI.
 * Returns a flat number[] on success, or null on error (never throws).
 *
 * Output dimension: 768 (matches previous gemini-embedding-001 output).
 *
 * NOTE: If you had embeddings from gemini-embedding-001, they are from a
 * different model space. Run backfill_embeddings.js to re-embed existing entries.
 */
async function embed(text) {
  if (!text || typeof text !== "string") return null;

  if (useLocal()) {
    return localEmbed(text);
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.warn(`[llm/embed] auth error: ${err.message}`);
    return null;
  }
  const { project, location } = getProjectConfig();

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 30_000);

  try {
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${EMBED_MODEL}:predict`;
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      signal:  controller.signal,
      body: JSON.stringify({
        instances: [{ content: text.slice(0, 2048) }],
        parameters: { outputDimensionality: 768 },
      }),
    });

    if (!res.ok) {
      console.warn(`[llm/embed] HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const vec  = data?.predictions?.[0]?.embeddings?.values;
    if (!Array.isArray(vec) || vec.length === 0) {
      console.warn("[llm/embed] unexpected response shape");
      return null;
    }

    return vec;
  } catch (err) {
    if (err.name !== "AbortError") {
      console.warn(`[llm/embed] error: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
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
