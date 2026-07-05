#!/usr/bin/env node
/**
 * runner/lib/recall.js — programmatic memory recall.
 *
 * The CLI at runner/recall.js writes to state/memory_recall.txt and can't be
 * called in-process. This module exposes the same semantic→FTS5 recall as a
 * plain function so other modules (notably lib/refine.js) can ground their
 * reasoning in what Sebastian already knows.
 *
 * Semantic first (nomic-embed-text cosine similarity over stored embeddings),
 * falling back to FTS5 when embeddings are unavailable or score too low —
 * mirrors the fallback logic in runner/recall.js.
 *
 * No side effects; safe to call every cycle.
 */

"use strict";

const { loadScraperDb } = require("./db_backend");
const { embed, topK } = require("../../scraper/embed");

const db = loadScraperDb();
const SEM_MIN_SCORE = 0.05;

async function semanticRecall(queryText, typeFilter, limitN) {
  const queryVec = await embed(queryText);
  if (!queryVec) return null;
  const embeddings = await db.allEmbeddings("memory");
  if (!embeddings || embeddings.length === 0) return null;
  const nearest = topK(queryVec, embeddings, limitN * 3);
  const results = [];
  for (const hit of nearest) {
    const row = await Promise.resolve(db.getMemoryById(hit.entity_id));
    if (!row) continue;
    if (typeFilter && row.type !== typeFilter) continue;
    results.push({ ...row, _similarity: hit.similarity });
    if (results.length >= limitN) break;
  }
  return results;
}

/**
 * recall({ query, type, limit }) → Promise<Array<{content,type,...}>>
 *
 * @param {object} opts
 * @param {string} opts.query   - query text (required for a search; omit for "recent")
 * @param {string} [opts.type]  - restrict to a memory type
 * @param {number} [opts.limit=5]
 * @returns {Promise<Array>} matching rows (may be empty). Never throws.
 */
async function recall({ query, type = null, limit = 5 } = {}) {
  try {
    if (!query) {
      return await Promise.resolve(db.recentMemory(type || null, limit));
    }
    const sem = await semanticRecall(query, type || null, limit);
    const best = sem?.length ? (sem[0]._similarity ?? 0) : 0;
    if (sem && sem.length > 0 && best >= SEM_MIN_SCORE) return sem;

    // FTS5 fallback
    let rows = await Promise.resolve(db.recallMemory(query, limit));
    if (type) rows = rows.filter((r) => r.type === type);
    return rows;
  } catch {
    return [];
  }
}

/**
 * recallText(query, opts) → Promise<string>
 * Convenience: recall then flatten into a compact context block for prompts.
 */
async function recallText(query, { type = null, limit = 5, maxChars = 1200 } = {}) {
  const rows = await recall({ query, type, limit });
  if (!rows || rows.length === 0) return "";
  const lines = rows
    .map((r) => `- ${(r.content || r.text || "").replace(/\s+/g, " ").trim()}`)
    .filter((l) => l.length > 2);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "…";
  return out;
}

module.exports = { recall, recallText, semanticRecall };
