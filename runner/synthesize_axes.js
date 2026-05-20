#!/usr/bin/env node
/**
 * runner/synthesize_axes.js — identify tension pairs and write synthesis proposals
 *
 * Runs daily. Reads ontology.json, finds pairs of opposing axes that both have
 * sufficient evidence (confidence >= 0.5, evidence_log >= 5, |score| > 0.15).
 * Writes qualifying pairs to state/synthesis_proposals.json as pending proposals.
 *
 * The browse agent reads pending proposals via context.js and may draft a synthesis
 * axis into ontology_delta.json (synthesis_of: [axis_a_id, axis_b_id]).
 *
 * Usage: node runner/synthesize_axes.js
 * Called by runner/run.sh daily maintenance block.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const config = require("./lib/config");

const ONTOLOGY_PATH  = config.ONTOLOGY_PATH;
const PROPOSALS_PATH = config.SYNTHESIS_PROPOSALS_PATH;

const CONFIDENCE_MIN  = 0.6;
const EVIDENCE_MIN    = 8;
const SCORE_MIN       = 0.15;
const OVERLAP_MIN     = 2;  // require at least 2 shared tokens to avoid spurious pairings
const MAX_NEW_PER_RUN = 5;  // cap new proposals added per daily run

const STOP = new Set(["of","and","in","the","a","an","for","to","vs","or","with","at","by","from","on"]);

function tokens(str) {
  return new Set(
    (str || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w))
  );
}

function findTensionPairs(axes) {
  const qualified = axes.filter(a =>
    Math.abs(a.score || 0) > SCORE_MIN &&
    (a.confidence || 0) >= CONFIDENCE_MIN &&
    (a.evidence_log || []).length >= EVIDENCE_MIN
  );

  if (qualified.length < 2) return [];

  const pairs = [];

  for (let i = 0; i < qualified.length; i++) {
    for (let j = i + 1; j < qualified.length; j++) {
      const a = qualified[i];
      const b = qualified[j];

      if (Math.sign(a.score) === Math.sign(b.score)) continue;

      const tokA = new Set([...tokens(a.label), ...tokens(a.left_pole || ""), ...tokens(a.right_pole || "")]);
      const tokB = new Set([...tokens(b.label), ...tokens(b.left_pole || ""), ...tokens(b.right_pole || "")]);
      const overlap = [...tokA].filter(t => tokB.has(t)).length;
      if (overlap < OVERLAP_MIN) continue;

      const tension  = Math.abs(a.score) + Math.abs(b.score);
      const confAvg  = ((a.confidence || 0) + (b.confidence || 0)) / 2;
      const score    = tension * overlap * confAvg;

      pairs.push({ a, b, overlap, tension, score });
    }
  }

  // Sort strongest tension first
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

function loadProposals() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROPOSALS_PATH, "utf-8"));
    return Array.isArray(raw.proposals) ? raw.proposals : [];
  } catch {
    return [];
  }
}

function saveProposals(proposals) {
  fs.writeFileSync(PROPOSALS_PATH, JSON.stringify({ proposals }, null, 2), "utf-8");
}

function proposalId(axisAId, axisBId) {
  const [x, y] = [axisAId, axisBId].sort();
  return `synth_${x}_${y}`;
}

(function main() {
  if (!fs.existsSync(ONTOLOGY_PATH)) {
    console.log("[synthesize_axes] ontology.json not found — skipping");
    return;
  }

  let axes;
  try {
    axes = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, "utf-8")).axes || [];
  } catch (e) {
    console.error("[synthesize_axes] failed to parse ontology.json:", e.message);
    return;
  }

  const pairs     = findTensionPairs(axes);
  const existing  = loadProposals();
  const existIds  = new Set(existing.map(p => p.id));

  const now = new Date().toISOString();
  let added = 0;

  for (const { a, b, tension, score } of pairs) {
    if (added >= MAX_NEW_PER_RUN) break;
    const id = proposalId(a.id, b.id);
    if (existIds.has(id)) continue;

    existing.push({
      id,
      axis_a_id:    a.id,
      axis_a_label: a.label,
      axis_a_score: parseFloat((a.score || 0).toFixed(4)),
      axis_b_id:    b.id,
      axis_b_label: b.label,
      axis_b_score: parseFloat((b.score || 0).toFixed(4)),
      tension:      parseFloat(tension.toFixed(4)),
      score:        parseFloat(score.toFixed(4)),
      created_at:   now,
      status:       "pending",
    });
    added++;
  }

  if (added > 0) {
    saveProposals(existing);
    console.log(`[synthesize_axes] added ${added} new proposal(s) — total: ${existing.length}`);
  } else {
    const pendingCount = existing.filter(p => p.status === "pending").length;
    console.log(`[synthesize_axes] no new pairs — ${pendingCount} pending proposal(s) already queued`);
  }
})();
