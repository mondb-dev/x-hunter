#!/usr/bin/env node
/**
 * scripts/backfill_trust_graph.js — one-off script to re-classify existing
 * trust graph entries with proper LLM-generated cluster labels and follow reasons.
 *
 * Reads state/trust_graph.json, re-classifies each followed account using the
 * same LLM approach as scraper/follows.js classifyFollow(), and writes back.
 *
 * Usage: node scripts/backfill_trust_graph.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("../scraper/db");
const { callVertex } = require("../runner/vertex.js");

const ROOT       = path.resolve(__dirname, "..");
const TRUST_GRAPH = path.join(ROOT, "state", "trust_graph.json");
const ONTOLOGY    = path.join(ROOT, "state", "ontology.json");

// Load .env
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function classifyAccount(username, ontologyAxes) {
  const samplePosts = db.postsByUser(username, 5)
    .map(p => p.text?.slice(0, 200))
    .filter(Boolean);

  if (samplePosts.length === 0) return null; // no data to classify

  const axisLabels = (ontologyAxes || []).map(a => a.label).join(", ");

  const prompt = [
    "You are classifying an X (Twitter) account for a belief-tracking agent's trust graph.",
    "",
    `Account: @${username}`,
    samplePosts.length ? `Sample posts:\n${samplePosts.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "",
    "",
    `The agent tracks these belief axes: ${axisLabels || "(none yet)"}`,
    "",
    "Respond with EXACTLY two lines, nothing else:",
    "Line 1: A 2-4 word topic cluster label for this account (e.g. \"US Foreign Policy\", \"AI Ethics\", \"Middle East Conflict\", \"Crypto Governance\")",
    "Line 2: One sentence explaining why this account is worth following (what perspective or information they provide)",
  ].filter(Boolean).join("\n");

  try {
    const result = await callVertex(prompt, 1024, { thinkingBudget: 0 });
    const lines = result.trim().split("\n").filter(Boolean);
    if (lines.length >= 2) {
      return {
        cluster: lines[0].replace(/^(cluster|label|line ?1)[:\s]*/i, "").trim().slice(0, 50),
        reason:  lines[1].replace(/^(reason|line ?2)[:\s]*/i, "").trim().slice(0, 200),
      };
    }
  } catch (err) {
    console.error(`[backfill] LLM failed for @${username}: ${err.message}`);
  }
  return null;
}

(async () => {
  const trustGraph = loadJson(TRUST_GRAPH, { accounts: {} });
  const ontology   = loadJson(ONTOLOGY, { axes: [] });
  const accounts = trustGraph.accounts || {};
  const followed = Object.entries(accounts).filter(([, d]) => d.followed);

  console.log(`[backfill] ${followed.length} followed accounts to re-classify`);

  let updated = 0, skipped = 0, failed = 0;

  for (const [username, data] of followed) {
    const classification = await classifyAccount(username, ontology.axes);

    if (classification) {
      data.cluster = classification.cluster;
      data.follow_reason = classification.reason;
      updated++;
      console.log(`  ✓ @${username}: ${classification.cluster}`);
    } else {
      skipped++;
      console.log(`  – @${username}: no posts in DB, skipped`);
    }

    // Small delay to avoid rate-limiting Vertex
    await sleep(500);
  }

  trustGraph.last_updated = new Date().toISOString();
  fs.writeFileSync(TRUST_GRAPH, JSON.stringify(trustGraph, null, 2));
  console.log(`\n[backfill] done: ${updated} updated, ${skipped} skipped, ${failed} failed`);
})();
