#!/usr/bin/env node
"use strict";
/**
 * runner/backfill_evidence_summaries.js — generate summaries for evidence entries
 *
 * All 6,332 evidence entries currently have summary: "" or no summary field.
 * Without summaries, semantic search over evidence is non-functional.
 *
 * This script:
 *   1. Loads state/ontology.json
 *   2. For each axis → each evidence entry without a summary
 *   3. Calls Gemini Flash to generate a 1-2 sentence summary
 *   4. Writes summary back to the entry in-place
 *   5. Saves ontology.json after every BATCH_SIZE entries (checkpoint)
 *
 * Estimated cost: ~$0.24 for 6,332 entries at Gemini Flash rates.
 * Estimated runtime: ~45 min (rate-limited to ~140 req/min).
 *
 * Run on VM:
 *   nohup node runner/backfill_evidence_summaries.js > /tmp/backfill_summaries.log 2>&1 &
 *   tail -f /tmp/backfill_summaries.log
 *
 * After this completes, re-run embedding backfill to embed the new summaries:
 *   nohup node runner/backfill_embeddings.js > /tmp/backfill.log 2>&1 &
 */

const fs   = require("fs");
const path = require("path");

const ROOT  = path.resolve(__dirname, "..");
const ONTO  = path.join(ROOT, "state", "ontology.json");

const { generate } = require("./llm.js");

const BATCH_SIZE    = 50;   // save ontology.json every N entries
const DELAY_MS      = 430;  // ~140 req/min — stays within Gemini Flash quota
const MAX_RETRIES   = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateSummaryWithRetry(axis, entry) {
  const prompt =
`Axis: "${axis.label}"
Axis score direction: ${entry.pole_alignment === "right" ? "supports" : "opposes"} the right pole
Source URL: ${entry.source}
Left pole: "${axis.left_pole || ""}"
Right pole: "${axis.right_pole || ""}"
Content observed: "${(entry.content || "").slice(0, 300)}"

Write a 1-2 sentence factual summary of what this source observed and why it ${entry.pole_alignment === "right" ? "supports" : "challenges"} the axis position. Be specific. If the source is a tweet URL, describe what kind of claim a post from that account on this topic would typically contain. Keep under 200 characters. Return only the summary text, no other output.`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await generate(prompt, { temperature: 0.2, maxTokens: 120 });
      const summary = text.trim().replace(/^["']|["']$/g, "").slice(0, 200);
      if (summary.length > 10) return summary;
      throw new Error("summary too short");
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(DELAY_MS * attempt * 2);
      } else {
        throw err;
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log("[backfill_summaries] loading ontology.json...");
  let onto;
  try {
    onto = JSON.parse(fs.readFileSync(ONTO, "utf-8"));
  } catch (e) {
    console.error(`[backfill_summaries] could not load ontology.json: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(onto.axes)) {
    console.error("[backfill_summaries] ontology.json has no axes array");
    process.exit(1);
  }

  // Count entries needing summaries
  let totalNeedSummary = 0;
  for (const axis of onto.axes) {
    for (const e of (axis.evidence_log || [])) {
      if (!e.summary || e.summary.trim() === "") totalNeedSummary++;
    }
  }
  console.log(`[backfill_summaries] ${totalNeedSummary} entries need summaries across ${onto.axes.length} axes`);

  if (totalNeedSummary === 0) {
    console.log("[backfill_summaries] nothing to backfill");
    process.exit(0);
  }

  let processed = 0;
  let errors    = 0;
  let batchCount = 0;

  for (const axis of onto.axes) {
    const log = axis.evidence_log || [];
    for (const entry of log) {
      if (entry.summary && entry.summary.trim() !== "") continue;

      try {
        const summary = await generateSummaryWithRetry(axis, entry);
        entry.summary = summary;
        processed++;
        batchCount++;

        if (batchCount >= BATCH_SIZE) {
          fs.writeFileSync(ONTO, JSON.stringify(onto, null, 2), "utf-8");
          console.log(`[backfill_summaries] checkpoint: ${processed}/${totalNeedSummary} processed, ${errors} errors`);
          batchCount = 0;
        }

        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`[backfill_summaries] failed on ${axis.id} source=${entry.source?.slice(0, 60)}: ${err.message}`);
        entry.summary = "";
        errors++;
      }
    }
  }

  // Final save
  fs.writeFileSync(ONTO, JSON.stringify(onto, null, 2), "utf-8");
  console.log(`[backfill_summaries] done — ${processed} summaries written, ${errors} errors`);
  console.log("[backfill_summaries] next step: run node runner/backfill_embeddings.js to embed the new summaries");
})().catch(err => {
  console.error(`[backfill_summaries] fatal: ${err.message}`);
  process.exit(1);
});
