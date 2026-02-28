#!/usr/bin/env node
"use strict";
/**
 * scraper/embed.js — text embedding via Ollama (nomic-embed-text)
 *
 * Exports:
 *   embed(text)           → Promise<number[]|null>  768-dim vector, or null on error
 *   cosineSimilarity(a,b) → number in [-1, 1]
 *   topK(query, entries, k) → entries sorted by descending cosine similarity
 *
 * entries: [{entity_id, vector, ...}]  (as returned by db.allEmbeddings())
 *
 * Model: nomic-embed-text (768 dimensions, ~274MB, runs locally on Ollama)
 * API:   POST http://localhost:11434/api/embeddings
 */

const OLLAMA_URL   = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL  = "nomic-embed-text";
const TIMEOUT_MS   = 30_000;

/**
 * Generate an embedding for `text` via Ollama.
 * Returns a flat number[] on success, or null on error (never throws).
 */
async function embed(text) {
  if (!text || typeof text !== "string") return null;

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body:    JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2048) }),
    });

    if (!res.ok) {
      console.warn(`[embed] Ollama HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      console.warn("[embed] unexpected response shape");
      return null;
    }

    return data.embedding;
  } catch (err) {
    if (err.name !== "AbortError") {
      console.warn(`[embed] error: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 if either vector is zero-length.
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
 * Return top-k entries from `entries` by cosine similarity to `queryVec`.
 * entries: [{entity_id, vector, ...extra}]
 * Returns entries sorted descending, with `.similarity` field added.
 */
function topK(queryVec, entries, k = 5) {
  if (!queryVec || entries.length === 0) return [];
  return entries
    .map(e => ({ ...e, similarity: cosineSimilarity(queryVec, e.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

module.exports = { embed, cosineSimilarity, topK };
