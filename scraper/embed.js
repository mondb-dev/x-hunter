#!/usr/bin/env node
"use strict";
/**
 * scraper/embed.js — text embedding via Gemini text-embedding-004
 *
 * Thin re-export of runner/llm.js embedding functions.
 * Keeps the same API so all callers (recall.js, cluster_axes.js, backfill_embeddings.js)
 * continue to work unchanged.
 *
 * Exports:
 *   embed(text)           → Promise<number[]|null>  768-dim vector, or null on error
 *   cosineSimilarity(a,b) → number in [-1, 1]
 *   topK(query, entries, k) → entries sorted by descending cosine similarity
 */

const path = require("path");
const llm  = require(path.join(__dirname, "..", "runner", "llm.js"));

module.exports = { embed: llm.embed, cosineSimilarity: llm.cosineSimilarity, topK: llm.topK };
