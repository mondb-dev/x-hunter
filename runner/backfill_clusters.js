#!/usr/bin/env node
/**
 * runner/backfill_clusters.js — retrofit cluster labels to taxonomy for followed accounts
 *
 * Only processes followed accounts whose cluster is not in CLUSTER_TAXONOMY.
 * Calls Gemini Flash to classify each, updates trust_graph.json.
 * Safe to re-run (skips accounts already correctly classified).
 *
 * Usage: node runner/backfill_clusters.js
 */
"use strict";

const fs   = require("fs");
const path = require("path");
(() => { try { require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") }); } catch {} })();

const ROOT       = path.resolve(__dirname, "..");
const TRUST_PATH = path.join(ROOT, "state", "trust_graph.json");

const { callBuilder } = require("./builder_vertex.js");
const db = require("../scraper/db.js");

const CLUSTER_TAXONOMY = [
  "geopolitics", "us_politics", "middle_east", "asia_pacific", "latin_america", "europe",
  "economics", "markets_finance", "tech_ai", "science", "disinformation", "accountability_journalism",
  "legal_courts", "military", "climate_energy", "health", "crypto_web3", "entertainment", "sports",
  "animal_content", "humor_memes", "religion", "human_rights", "sovereignty", "elections",
  "media_criticism", "conspiracy", "academic_research", "government_official", "breaking_news",
];

const TAXONOMY_STR = CLUSTER_TAXONOMY.join(", ");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function classify(username, followReason, topKeywords) {
  const posts = db.postsByUser(username, 5).map(p => p.text?.slice(0, 200)).filter(Boolean);
  const prompt = [
    `Classify X account @${username} into EXACTLY ONE category from this list:`,
    `[${TAXONOMY_STR}]`,
    "",
    `Follow reason on file: ${followReason || "(none)"}`,
    `Top keywords: ${topKeywords || "(none)"}`,
    posts.length ? `Recent posts:\n${posts.map((t, i) => `${i+1}. ${t}`).join("\n")}` : "",
    "",
    "Return ONLY the single label string from the list. No explanation, no quotes.",
  ].filter(Boolean).join("\n");

  try {
    const result = await callBuilder(prompt, 400);
    const clean = (result || "").trim().toLowerCase().replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, "_");
    // Try exact match first
    if (CLUSTER_TAXONOMY.includes(clean)) return clean;
    // Try partial match
    const partial = CLUSTER_TAXONOMY.find(t => clean.includes(t) || t.includes(clean));
    if (partial) return partial;
    return "geopolitics"; // fallback
  } catch (err) {
    console.error(`  classify failed for @${username}: ${err.message}`);
    return null;
  }
}

(async () => {
  const tg = JSON.parse(fs.readFileSync(TRUST_PATH, "utf-8"));
  const accounts = tg.accounts || {};

  const toFix = Object.entries(accounts)
    .filter(([, v]) => v.followed && !CLUSTER_TAXONOMY.includes(v.cluster));

  console.log(`[backfill_clusters] ${toFix.length} followed accounts need reclassification`);

  let fixed = 0;
  let failed = 0;
  for (const [username, acct] of toFix) {
    process.stdout.write(`  @${username} (current: "${acct.cluster}") → `);
    const newCluster = await classify(username, acct.follow_reason, acct.top_keywords);
    if (newCluster) {
      acct.cluster = newCluster;
      console.log(newCluster);
      fixed++;
    } else {
      console.log("FAILED (kept as-is)");
      failed++;
    }
    // Save incrementally every 10 to avoid losing progress
    if ((fixed + failed) % 10 === 0) {
      tg.last_updated = new Date().toISOString();
      fs.writeFileSync(TRUST_PATH, JSON.stringify(tg, null, 2));
      console.log(`  [checkpoint] saved at ${fixed + failed}/${toFix.length}`);
    }
    await sleep(300); // 300ms between calls to avoid rate limiting
  }

  tg.last_updated = new Date().toISOString();
  fs.writeFileSync(TRUST_PATH, JSON.stringify(tg, null, 2));
  console.log(`\n[backfill_clusters] done. fixed=${fixed} failed=${failed}`);
})().catch(err => {
  console.error(`[backfill_clusters] fatal: ${err.message}`);
  process.exit(1);
});
