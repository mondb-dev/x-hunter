#!/usr/bin/env node
"use strict";
/**
 * runner/backfill_trust.js — one-time trust score backfill
 *
 * Computes trust scores 1-7 for every account in the SQLite accounts table,
 * then writes them back to both:
 *   - SQLite `accounts.trust` (for SQL queries)
 *   - `state/trust_graph.json` trust_score (for collect.js RAKE scoring)
 *
 * Algorithm (per recommendations doc #3):
 *   1. Percentile rank each account by composite score:
 *        avg_velocity×0.40 + avg_score×0.30 + post_count×0.30
 *   2. Map percentile → raw trust 1-7:
 *        bottom 15% → 1, 15-35% → 2, 35-55% → 3, 55-75% → 4,
 *        75-90% → 5, 90-97% → 6, top 3% → 7
 *   3. Apply cluster-based floor/cap adjustments from trust_graph.json
 *   4. UPDATE accounts SET trust = ? for each account
 *   5. Upsert trust_score into trust_graph.json for each account
 *
 * Run once on VM:
 *   node runner/backfill_trust.js
 * Then add to daily.js for weekly recalibration.
 */

const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..");
const TRUST_PATH  = path.join(ROOT, "state", "trust_graph.json");
const db          = require("../scraper/db.js");
const rawDb       = db.raw();

// ── Percentile → trust mapping ────────────────────────────────────────────────
function percentileToTrust(pct) {
  if (pct < 0.15) return 1;
  if (pct < 0.35) return 2;
  if (pct < 0.55) return 3;
  if (pct < 0.75) return 4;
  if (pct < 0.90) return 5;
  if (pct < 0.97) return 6;
  return 7;
}

// ── Cluster-based adjustments ─────────────────────────────────────────────────
const CLUSTER_CAP = {
  entertainment: 2, animal_content: 2, humor_memes: 2,
  sports: 2,
  conspiracy: 1,
};
const CLUSTER_FLOOR = {
  geopolitics: 4, accountability_journalism: 4, academic_research: 4,
  science: 4, legal_courts: 4, disinformation: 4,
  government_official: 3, breaking_news: 3, military: 3,
};

function adjustByCluster(trust, cluster) {
  if (!cluster) return trust;
  const c = String(cluster).toLowerCase().replace(/[^a-z_]/g, "_");
  const cap   = CLUSTER_CAP[c];
  const floor = CLUSTER_FLOOR[c];
  let adjusted = trust;
  if (cap   !== undefined) adjusted = Math.min(adjusted, cap);
  if (floor !== undefined) adjusted = Math.max(adjusted, floor);
  return adjusted;
}

// ── Load trust graph ──────────────────────────────────────────────────────────
let trustGraph = { accounts: {} };
try {
  trustGraph = JSON.parse(fs.readFileSync(TRUST_PATH, "utf-8"));
  if (!trustGraph.accounts) trustGraph.accounts = {};
} catch { /* fresh or missing */ }

// ── Load all accounts from SQLite ─────────────────────────────────────────────
const accounts = rawDb.prepare("SELECT * FROM accounts").all();
console.log(`[backfill_trust] loaded ${accounts.length} accounts from SQLite`);

if (!accounts.length) {
  console.log("[backfill_trust] nothing to backfill");
  process.exit(0);
}

// ── Compute composite score for percentile ranking ────────────────────────────
const maxVel   = Math.max(...accounts.map(a => a.avg_velocity || 0)) || 1;
const maxScore = Math.max(...accounts.map(a => a.avg_score    || 0)) || 1;
const maxCount = Math.max(...accounts.map(a => a.post_count   || 0)) || 1;

const scored = accounts.map(a => ({
  username: a.username,
  composite: (a.avg_velocity / maxVel) * 0.40
           + (a.avg_score    / maxScore) * 0.30
           + (a.post_count   / maxCount) * 0.30,
})).sort((a, b) => a.composite - b.composite);

// ── Assign trust + update SQLite + update trust_graph ────────────────────────
const stmtUpdate = rawDb.prepare("UPDATE accounts SET trust = ? WHERE username = ?");

const updateAll = rawDb.transaction(() => {
  for (let i = 0; i < scored.length; i++) {
    const { username } = scored[i];
    const pct = i / (scored.length - 1 || 1);
    const rawTrust = percentileToTrust(pct);

    // Cluster lookup from trust_graph.json
    const tgEntry = trustGraph.accounts[username.toLowerCase()];
    const cluster = tgEntry?.cluster || null;
    const trust   = adjustByCluster(rawTrust, cluster);

    // Update SQLite
    stmtUpdate.run(trust, username);

    // Upsert into trust_graph.json
    const key = username.toLowerCase();
    trustGraph.accounts[key] = {
      ...(trustGraph.accounts[key] || {}),
      trust_score: trust,
    };
  }
});

updateAll();

// ── Write updated trust_graph.json ────────────────────────────────────────────
trustGraph.last_updated = new Date().toISOString();
fs.writeFileSync(TRUST_PATH, JSON.stringify(trustGraph, null, 2), "utf-8");

// ── Summary ───────────────────────────────────────────────────────────────────
const dist = [1,2,3,4,5,6,7].map(t => {
  const n = scored.filter((_, i) => {
    const pct = i / (scored.length - 1 || 1);
    return percentileToTrust(pct) === t;
  }).length;
  return `${t}:${n}`;
}).join(" ");

console.log(`[backfill_trust] updated ${scored.length} accounts — distribution: ${dist}`);
console.log(`[backfill_trust] trust_graph.json written (${Object.keys(trustGraph.accounts).length} entries)`);
