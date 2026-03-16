#!/usr/bin/env node
/**
 * runner/llm.js — shared Gemini Flash helper (replaces local Ollama)
 *
 * Exports:
 *   generate(prompt, opts)  → Promise<string>       text response
 *   embed(text)             → Promise<number[]|null> 768-dim vector
 *   cosineSimilarity(a, b)  → number in [-1, 1]
 *   topK(queryVec, entries, k) → sorted entries with .similarity
 *
 * Uses GOOGLE_API_KEY_REFLECTION for all calls.
 * Falls back to GOOGLE_API_KEY if REFLECTION key is not set.
 *
 * Models:
 *   generate → gemini-2.5-flash
 *   embed    → text-embedding-004 (768 dimensions, matches nomic-embed-text)
 */

"use strict";

const API_KEY = process.env.GOOGLE_API_KEY_REFLECTION
             || process.env.GOOGLE_API_KEY
             || "";

const GENERATE_MODEL = "gemini-2.5-flash";
const EMBED_MODEL    = "gemini-embedding-001";
const BASE_URL       = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Generate text via Gemini Flash.
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
  } = opts;

  if (!API_KEY) throw new Error("[llm] no API key (set GOOGLE_API_KEY_REFLECTION)");

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${BASE_URL}/models/${GENERATE_MODEL}:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    // Response may have multiple parts (thinking + text) — concatenate text parts only
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter(p => p.text !== undefined && !p.thought)
      .map(p => p.text)
      .join("");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate an embedding via Gemini text-embedding-004.
 * Returns a flat number[] on success, or null on error (never throws).
 *
 * Output dimension: 768 (matches nomic-embed-text for DB compatibility).
 */
async function embed(text) {
  if (!text || typeof text !== "string") return null;
  if (!API_KEY) {
    console.warn("[llm/embed] no API key");
    return null;
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 30_000);

  try {
    const url = `${BASE_URL}/models/${EMBED_MODEL}:embedContent?key=${API_KEY}`;
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, 2048) }] },
        outputDimensionality: 768,
      }),
    });

    if (!res.ok) {
      console.warn(`[llm/embed] HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const vec  = data?.embedding?.values;
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
