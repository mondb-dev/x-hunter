#!/usr/bin/env node
/**
 * runner/landmark/index.js — Landmark event orchestrator
 *
 * This is the top-level entry point for the landmark pipeline.
 * It ties together all modules in sequence:
 *
 *   1. detect   — scan DB for landmark events
 *   2. filter   — cooldown + dedup checks
 *   3. editorial — generate headline + lead + full article
 *   4. art      — generate hero art (Imagen 3)
 *   5. render   — composite card SVG → PNG
 *   6. mint     — upload to Arweave → create Metaplex Master Edition
 *   7. record   — persist state + log
 *
 * Usage: node runner/landmark/index.js [--dry-run] [--force]
 *
 * Flags:
 *   --dry-run   Run detection + editorial but skip art/render/mint
 *   --force     Ignore cooldown and enabled checks
 *
 * Exit codes:
 *   0  success (or no events detected)
 *   1  error
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── Module imports ────────────────────────────────────────────────────────────

const { EDITION_SUPPLY, CARD_TIERS, PATHS } = require("./config");
const { loadState, saveState, isCooldownClear, isDuplicate, recordLandmark } = require("./state");
const { detect } = require("./detect");
const { generateEditorial, buildArweaveHtml } = require("./editorial");
const { generateHeroArt } = require("./art");
const { renderAndSave } = require("./render");
const { mintLandmark } = require("./mint");

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args    = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE   = args.has("--force");

// ── DB access ─────────────────────────────────────────────────────────────────

function getDb() {
  const dbPath = path.join(PATHS.ROOT, "scraper", "db.js");
  const db = require(dbPath);
  return db.raw();   // returns the better-sqlite3 handle
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║   LANDMARK EVENT PIPELINE                 ║");
  console.log("╚═══════════════════════════════════════════╝");
  console.log(`[landmark] ${new Date().toISOString()}`);
  if (DRY_RUN) console.log("[landmark] DRY RUN — no art/render/mint");
  if (FORCE)   console.log("[landmark] FORCE — ignoring cooldown/enabled checks");

  // ── Pre-flight checks ───────────────────────────────────────────────────

  const state = loadState();

  if (!state.enabled && !FORCE) {
    console.log("[landmark] Pipeline is DISABLED. Set enabled:true in landmark_state.json or use --force.");
    return;
  }

  if (!isCooldownClear() && !FORCE) {
    console.log("[landmark] Cooldown active — skipping this run.");
    return;
  }

  // ── 1. Detection ────────────────────────────────────────────────────────

  console.log("\n── STEP 1: Event Detection ──");
  const dbRaw = getDb();
  const events = detect(dbRaw);

  if (events.length === 0) {
    console.log("[landmark] No landmark events detected in current data.");
    return;
  }

  console.log(`[landmark] Detected ${events.length} candidate event(s)`);

  // Process only the strongest event per run
  const event = events[0];
  console.log(`[landmark] Top event: ${event.signalCount}/6 signals`);
  console.log(`[landmark] Keywords: ${(event.topKeywords || []).join(", ")}`);

  // ── 2. Dedup check ─────────────────────────────────────────────────────

  if (isDuplicate(event.topKeywords || []) && !FORCE) {
    console.log("[landmark] Event is a duplicate of recent landmark — skipping.");
    return;
  }

  // ── 3. Editorial ────────────────────────────────────────────────────────

  console.log("\n── STEP 3: Editorial Generation ──");
  let content;
  try {
    content = await generateEditorial(event);
    console.log(`[landmark] Headline: ${content.headline}`);
    console.log(`[landmark] Lead: ${content.lead.slice(0, 120)}...`);
  } catch (err) {
    console.error(`[landmark] Editorial generation failed: ${err.message}`);
    throw err;
  }

  // Attach headline to event for downstream use
  event.headline = content.headline;

  const tierKey = Math.min(Math.max(event.signalCount, 3), 6);
  const tier = CARD_TIERS[tierKey];
  const supply = EDITION_SUPPLY[tierKey] || 1000;
  const landmarkNumber = (state.total_landmarks || 0) + 1;

  console.log(`[landmark] Tier: ${tier.name} | Supply: ${supply} | Landmark #${landmarkNumber}`);

  if (DRY_RUN) {
    console.log("\n── DRY RUN SUMMARY ──");
    console.log(JSON.stringify({
      landmarkNumber,
      signalCount: event.signalCount,
      tier: tier.name,
      supply,
      headline: content.headline,
      lead: content.lead,
      topKeywords: event.topKeywords,
    }, null, 2));

    // Still write editorial to disk for review
    const dir = path.join(PATHS.LANDMARKS_DIR, `landmark_${landmarkNumber}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const editorialHtml = buildArweaveHtml(event, content);
    fs.writeFileSync(path.join(dir, "editorial.html"), editorialHtml);
    fs.writeFileSync(path.join(dir, "event.json"), JSON.stringify(event, null, 2));
    console.log(`[landmark] Dry run artifacts saved to ${dir}`);
    return;
  }

  // ── 4. Hero Art Generation ──────────────────────────────────────────────

  console.log("\n── STEP 4: Hero Art Generation ──");
  let artBuf = null;
  let artPrompt = null;
  try {
    const artDir = path.join(PATHS.LANDMARKS_DIR, `landmark_${landmarkNumber}`);
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const result = await generateHeroArt(event, {
      outputPath: path.join(artDir, `landmark_${landmarkNumber}_hero.png`),
    });
    artBuf = result.buffer;
    artPrompt = result.prompt;
    console.log("[landmark] Hero art generated successfully");
  } catch (err) {
    console.warn(`[landmark] Hero art generation failed: ${err.message}`);
    console.warn("[landmark] Proceeding with placeholder art");
  }

  // ── 5. Card Rendering ──────────────────────────────────────────────────

  console.log("\n── STEP 5: Card Rendering ──");
  let cardPaths;
  try {
    cardPaths = await renderAndSave(event, content, artBuf, {
      landmarkNumber,
      editionSupply: supply,
      png: true,
    });
    console.log(`[landmark] Card rendered: SVG=${!!cardPaths.svgPath}, PNG=${!!cardPaths.pngPath}`);
  } catch (err) {
    console.error(`[landmark] Card rendering failed: ${err.message}`);
    throw err;
  }

  // ── 6. Mint ─────────────────────────────────────────────────────────────

  console.log("\n── STEP 6: Arweave Upload + Metaplex Mint ──");

  // Prefer PNG for NFT; fall back to SVG
  const cardImagePath = cardPaths.pngPath || cardPaths.svgPath;
  if (!cardImagePath || !fs.existsSync(cardImagePath)) {
    throw new Error("[landmark] No card image found — cannot mint");
  }

  const editorialHtml = buildArweaveHtml(event, content);
  let mintResult;
  try {
    mintResult = await mintLandmark(event, content, editorialHtml, cardImagePath, {
      landmarkNumber,
    });
    console.log(`[landmark] Minted! Address: ${mintResult.mintAddress}`);
    console.log(`[landmark] Metadata: ${mintResult.metadataUri}`);
  } catch (err) {
    console.error(`[landmark] Mint failed: ${err.message}`);
    // Record the detection even if mint fails
    recordLandmark(event, null);
    throw err;
  }

  // ── 7. Record ───────────────────────────────────────────────────────────

  console.log("\n── STEP 7: Recording ──");
  recordLandmark(event, {
    arweaveTx:    mintResult.imageUri,
    mintAddress:  mintResult.mintAddress,
    editionSupply: supply,
  });

  // Save full manifest for this landmark
  const manifestDir = path.join(PATHS.LANDMARKS_DIR, `landmark_${landmarkNumber}`);
  const manifest = {
    landmark_number: landmarkNumber,
    detected_at:     new Date().toISOString(),
    signal_count:    event.signalCount,
    signals:         event.signals,
    tier:            tier.name,
    edition_supply:  supply,
    headline:        content.headline,
    lead:            content.lead,
    top_keywords:    event.topKeywords || [],
    art_prompt:      artPrompt,
    arweave: {
      image:     mintResult.imageUri,
      editorial: mintResult.editorialUri,
      metadata:  mintResult.metadataUri,
    },
    solana: {
      mint_address: mintResult.mintAddress,
      signature:    mintResult.signature,
    },
  };

  fs.writeFileSync(
    path.join(manifestDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  // Also save editorial and event data
  fs.writeFileSync(path.join(manifestDir, "editorial.html"), editorialHtml);
  fs.writeFileSync(path.join(manifestDir, "event.json"), JSON.stringify(event, null, 2));

  console.log("\n╔═══════════════════════════════════════════╗");
  console.log(`║  LANDMARK #${String(landmarkNumber).padEnd(4)} COMPLETE                  ║`);
  console.log(`║  Tier: ${tier.name.padEnd(12)} Supply: ${String(supply).padEnd(13)}║`);
  console.log(`║  Mint: ${mintResult.mintAddress.slice(0, 33)}… ║`);
  console.log("╚═══════════════════════════════════════════╝");
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`[landmark] FATAL: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
