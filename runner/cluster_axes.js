#!/usr/bin/env node
/**
 * runner/cluster_axes.js — detect semantically redundant belief axes via embeddings
 *
 * Embeds each axis's label + pole descriptions using Ollama (nomic-embed-text).
 * Computes pairwise cosine similarity. Axis pairs above the similarity threshold
 * are proposed as merge candidates and written to state/ontology_merge_proposals.txt
 * (append-only — the agent reads and acts on these proposals).
 *
 * Also stores axis embeddings in the SQLite embeddings table (entity_type='axis')
 * for reuse on subsequent runs (only re-embeds new/changed axes).
 *
 * Threshold: 0.88 (tunable via CLUSTER_THRESHOLD env var)
 *
 * Usage:
 *   node runner/cluster_axes.js
 *   CLUSTER_THRESHOLD=0.85 node runner/cluster_axes.js  — more aggressive
 *
 * Called by run.sh every N curiosity cycles (every 12 browse cycles).
 * Non-fatal: exits 0 even on error.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("../scraper/db");
const { embed, cosineSimilarity } = require("../scraper/embed");

const ROOT       = path.resolve(__dirname, "..");
const ONTO       = path.join(ROOT, "state", "ontology.json");
const PROPOSALS  = path.join(ROOT, "state", "ontology_merge_proposals.txt");

const THRESHOLD  = parseFloat(process.env.CLUSTER_THRESHOLD || "0.88");

// ── Axis text representation for embedding ────────────────────────────────────

function axisText(axis) {
  return `${axis.label}: ${axis.left_pole} vs ${axis.right_pole}`;
}

/** Deterministic hash of axis text, for cheap change detection. */
function axisHash(axis) {
  const text = axisText(axis);
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return String(h >>> 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  if (!fs.existsSync(ONTO)) {
    console.log("[cluster_axes] ontology.json not found — skipping");
    process.exit(0);
  }

  let onto;
  try {
    onto = JSON.parse(fs.readFileSync(ONTO, "utf-8"));
  } catch (e) {
    console.error(`[cluster_axes] cannot parse ontology.json: ${e.message}`);
    process.exit(0);
  }

  const axes = (onto.axes || []).filter(a => a.id && a.label);
  if (axes.length < 2) {
    console.log("[cluster_axes] fewer than 2 axes — nothing to cluster");
    process.exit(0);
  }

  // ── Embed each axis (use cached embedding if text hash unchanged) ─────────
  // entity_id for axis embeddings = "<axis_id>:<hash>" so hash changes invalidate cache
  const axisVectors = [];

  for (const axis of axes) {
    const hash     = axisHash(axis);
    const entityId = `${axis.id}:${hash}`;

    let vec = db.getEmbedding("axis", entityId);
    if (!vec) {
      const text = axisText(axis);
      vec = await embed(text);
      if (!vec) {
        console.warn(`[cluster_axes] could not embed "${axis.label}" — skipping`);
        axisVectors.push(null);
        continue;
      }
      db.storeEmbedding("axis", entityId, vec);
    }

    axisVectors.push(vec);
  }

  // ── Pairwise cosine similarity ────────────────────────────────────────────
  const candidates = [];

  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      if (!axisVectors[i] || !axisVectors[j]) continue;

      const sim = cosineSimilarity(axisVectors[i], axisVectors[j]);
      if (sim >= THRESHOLD) {
        candidates.push({ i, j, sim });
      }
    }
  }

  if (candidates.length === 0) {
    console.log(`[cluster_axes] ${axes.length} axes checked, no similar pairs (threshold=${THRESHOLD})`);
    process.exit(0);
  }

  // ── Write merge proposals ─────────────────────────────────────────────────
  const now     = new Date().toISOString().slice(0, 16).replace("T", " ");
  const lines   = [`\n── axis merge proposals · ${now} (similarity threshold: ${THRESHOLD}) ──`];

  for (const { i, j, sim } of candidates.sort((a, b) => b.sim - a.sim)) {
    const A = axes[i];
    const B = axes[j];
    lines.push(
      `\nPROPOSED MERGE (sim=${sim.toFixed(3)}):` +
      `\n  A: [${A.id}] "${A.label}" — ${A.left_pole} ↔ ${A.right_pole}` +
      `\n  B: [${B.id}] "${B.label}" — ${B.left_pole} ↔ ${B.right_pole}` +
      `\n  Consider: are these the same dimension? If so, keep the one with more evidence` +
      ` (${(A.evidence_log||[]).length} vs ${(B.evidence_log||[]).length} entries).`
    );
  }

  lines.push("\n── end proposals ──\n");
  fs.appendFileSync(PROPOSALS, lines.join("\n") + "\n", "utf-8");

  console.log(
    `[cluster_axes] ${axes.length} axes checked — ${candidates.length} merge candidate pair(s) ` +
    `written to ontology_merge_proposals.txt`
  );
  process.exit(0);

})().catch(err => {
  console.error(`[cluster_axes] error: ${err.message}`);
  process.exit(0);
});
