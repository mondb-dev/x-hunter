#!/usr/bin/env node
/**
 * infra/seed_claims.js — Seed claim_verifications table from claim_tracker.json
 *
 * Reads state/claim_tracker.json, scores each claim using the same algorithm
 * as the verify worker, and inserts into claim_verifications in Postgres.
 *
 * Usage: node infra/seed_claims.js
 * Env:   DATABASE_URL — Postgres connection string
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load .env
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Inline scorer (mirrors claim_scorer.js)
function scoreClaim(claim) {
  const tier = claim.source_tier || 3;
  const breakdown = {
    source_tier:      (6 - tier) / 5,
    newsguard:        0.5,
    corroboration:    Math.min((claim.corroborating_count || 0) / 3, 1.0),
    evidence_quality: claim.cited_url ? (tier <= 2 ? 1.0 : 0.5) : 0.0,
    cross_source:     1 - ((claim.contradicting_count || 0) /
      Math.max((claim.corroborating_count || 0) + (claim.contradicting_count || 0), 1)),
    web_search:       0.5,
  };
  const weights = { source_tier: 0.30, newsguard: 0.15, corroboration: 0.20,
                    evidence_quality: 0.15, cross_source: 0.10, web_search: 0.10 };
  let confidence = 0;
  for (const [k, w] of Object.entries(weights)) confidence += breakdown[k] * w;
  confidence = Math.max(0, Math.min(1, confidence));
  return { confidence, breakdown };
}

async function main() {
  const trackerPath = path.join(__dirname, '../state/claim_tracker.json');
  if (!fs.existsSync(trackerPath)) {
    console.error('claim_tracker.json not found');
    process.exit(1);
  }

  const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf-8'));
  const claims  = tracker.claims || [];
  console.log(`[seed] ${claims.length} claims to seed`);

  let inserted = 0, skipped = 0;
  const now = new Date().toISOString();

  for (const claim of claims) {
    const { confidence, breakdown } = scoreClaim(claim);
    const status = claim.status || 'unverified';

    try {
      await pool.query(`
        INSERT INTO claim_verifications (
          claim_id, claim_source, claim_text, confidence_score, scoring_breakdown,
          status, verification_count, last_verified_at, source_handle, source_tier,
          related_axis_id, category, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (claim_id) DO NOTHING
      `, [
        claim.id || `claim_${inserted + 1}`,
        'tracker',
        claim.claim_text || claim.text,
        confidence,
        JSON.stringify(breakdown),
        status,
        0,
        now,
        claim.source_handle || null,
        claim.source_tier   || null,
        claim.related_axis_id || null,
        claim.category || null,
        claim.created_at || now,
        now,
      ]);
      console.log(`[seed] inserted: ${(claim.claim_text || claim.text || '').slice(0, 60)} (${Math.round(confidence * 100)}%)`);
      inserted++;
    } catch (err) {
      if (err.code === '23505') { skipped++; continue; } // duplicate
      console.error(`[seed] error on claim ${claim.id}: ${err.message}`);
    }
  }

  console.log(`[seed] done: ${inserted} inserted, ${skipped} skipped`);
  await pool.end();
}

main().catch(err => {
  console.error('[seed] fatal:', err.message);
  process.exit(1);
});
