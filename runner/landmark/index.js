#!/usr/bin/env node
/**
 * runner/landmark/index.js — Landmark event orchestrator
 *
 * This is the top-level entry point for the landmark pipeline.
 * It ties together all modules in sequence:
 *
 *   1. detect     — scan DB for landmark events
 *   2. filter     — cooldown + dedup checks
 *   3. editorial  — generate headline + lead + full article
 *   4. art        — generate hero art (Imagen) for article cover
 *   5. publish    — post as X Article (long-form) with cover image
 *   6. record     — persist state + log
 *
 * NFT minting is disabled — card rendering and Arweave/Metaplex
 * modules are preserved but not invoked.
 *
 * Usage: node runner/landmark/index.js [--dry-run] [--force]
 *
 * Flags:
 *   --dry-run   Run detection + editorial but skip art/publish
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

const { PATHS } = require("./config");
const { loadState, saveState, isCooldownClear, isDuplicate, recordLandmark } = require("./state");
const { detect } = require("./detect");
const { generateEditorial, buildArweaveHtml } = require("./editorial");
const { evaluateLandmark, validateEditorialForMint } = require("./tiering");
const { generateHeroArt } = require("./art");
// Card rendering + minting preserved but not invoked (NFT pipeline disabled)
// const { renderAndSave } = require("./render");
// const { mintLandmark } = require("./mint");
const { postArticle } = require("../post_article");
const { logArticle } = require("../posts_log");
const { connectBrowser, getXPage } = require("../cdp");

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
  if (DRY_RUN) console.log("[landmark] DRY RUN — no art/publish");
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
  // When forced, widen candidate window to match full lookback (scan everything)
  const detectOpts = FORCE ? { candidateMs: 7 * 24 * 60 * 60 * 1000 } : {};
  const events = detect(dbRaw, detectOpts);

  if (events.length === 0) {
    console.log("[landmark] No landmark events detected in current data.");
    return;
  }

  console.log(`[landmark] Detected ${events.length} candidate event(s)`);

  // Process only the strongest event per run
  const event = events[0];
  console.log(`[landmark] Top event: ${event.signalCount}/6 signals`);
  console.log(`[landmark] Keywords: ${(event.topKeywords || []).join(", ")}`);

  const gateEval = evaluateLandmark(event);
  console.log(
    `[landmark] Gate stage: ${gateEval.stage} | coherence ${gateEval.coherenceScore.toFixed(2)} | ` +
    `relevant posts ${gateEval.evidenceSummary.relevantPosts}`
  );

  if (!gateEval.articleEligible) {
    console.log("[landmark] Candidate-only event — skipping article/NFT publication.");
    return;
  }

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
  const landmarkNumber = (state.total_landmarks || 0) + 1;
  const manifestDir = path.join(PATHS.LANDMARKS_DIR, `landmark_${landmarkNumber}`);
  if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });

  const editorialValidation = validateEditorialForMint(event, content);
  const finalEval = evaluateLandmark(event, {
    editorialValidationPass: editorialValidation.passed,
    canonicalLandmarkPageExists: true,
  });
  const tier = finalEval.tier;
  const supply = tier.editionSupply;

  event.landmarkNumber = landmarkNumber;
  event.landmarkStage = finalEval.stage;
  event.landmarkTierKey = tier.id;
  event.coherenceScore = finalEval.coherenceScore;
  event.evidenceSummary = finalEval.evidenceSummary;
  event.editorialValidation = editorialValidation;

  console.log(
    `[landmark] Tier: ${tier.name} | Supply: ${supply} | Stage: ${finalEval.stage} | Landmark #${landmarkNumber}`
  );
  if (!editorialValidation.passed) {
    console.log(`[landmark] Tier 1 validation pending: ${editorialValidation.reasons.join("; ")}`);
  }

  if (DRY_RUN) {
    console.log("\n── DRY RUN SUMMARY ──");
    console.log(JSON.stringify({
      landmarkNumber,
      stage: finalEval.stage,
      signalCount: event.signalCount,
      tier: tier.id,
      coherenceScore: finalEval.coherenceScore,
      evidenceSummary: finalEval.evidenceSummary,
      editorialValidation,
      headline: content.headline,
      lead: content.lead,
      topKeywords: event.topKeywords,
    }, null, 2));

    // Still write editorial to disk for review
    const editorialHtml = buildArweaveHtml(event, content, { landmarkNumber });
    fs.writeFileSync(path.join(manifestDir, "editorial.html"), editorialHtml);
    fs.writeFileSync(path.join(manifestDir, "event.json"), JSON.stringify(event, null, 2));
    console.log(`[landmark] Dry run artifacts saved to ${manifestDir}`);
    return;
  }

  // ── 4. Hero Art Generation (cover image for X Article) ──────────────────

  console.log("\n── STEP 4: Hero Art Generation ──");
  let artBuf = null;
  let artPrompt = null;
  let artPath = null;
  try {
    artPath = path.join(manifestDir, `landmark_${landmarkNumber}_hero.png`);
    const result = await generateHeroArt(event, { outputPath: artPath });
    artBuf = result.buffer;
    artPrompt = result.prompt;
    console.log(`[landmark] Hero art generated: ${artPath}`);
  } catch (err) {
    console.warn(`[landmark] Hero art generation failed: ${err.message}`);
    console.warn("[landmark] Will publish article without cover image");
    artPath = null;
  }

  // ── 5. Publish as X Article ─────────────────────────────────────────────

  console.log("\n── STEP 5: X Article Publication ──");
  let articleUrl = null;
  try {
    const browser = await connectBrowser();
    const page    = await getXPage(browser);

    articleUrl = await postArticle(page, {
      title: content.headline,
      body:  content.editorial,
      imagePath: artPath,    // cover image (null = no image)
    });

    if (articleUrl) {
      console.log(`[landmark] X Article published: ${articleUrl}`);
    } else {
      console.log("[landmark] X Article published (URL not captured)");
    }

    browser.disconnect();
  } catch (err) {
    console.error(`[landmark] X Article publication failed: ${err.message}`);
    throw err;
  }

  // ── 6. Record ───────────────────────────────────────────────────────────

  console.log("\n── STEP 6: Recording ──");
  recordLandmark(event, null, {
    published: true,
    stage: finalEval.stage,
    tier: tier.id,
    editionSupply: supply,
    articleUrl,
  });  // no mint result

  // Save manifest
  const manifest = {
    landmark_number: landmarkNumber,
    detected_at:     new Date().toISOString(),
    stage:           finalEval.stage,
    signal_count:    event.signalCount,
    signals:         event.signals,
    tier:            tier.id,
    tier_name:       tier.name,
    edition_supply:  supply,
    coherence_score: finalEval.coherenceScore,
    evidence_summary: finalEval.evidenceSummary,
    editorial_validation: editorialValidation,
    headline:        content.headline,
    lead:            content.lead,
    top_keywords:    event.topKeywords || [],
    art_prompt:      artPrompt,
    x_article_url:   articleUrl,
  };

  fs.writeFileSync(
    path.join(manifestDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  // Save editorial and event data for reference
  const editorialHtml = buildArweaveHtml(event, content, { landmarkNumber });
  fs.writeFileSync(path.join(manifestDir, "editorial.html"), editorialHtml);
  fs.writeFileSync(path.join(manifestDir, "event.json"), JSON.stringify(event, null, 2));

  logArticle({
    title: content.headline,
    content: content.editorial,
    article_url: articleUrl || "",
    landmark_number: landmarkNumber,
  });

  console.log("\n╔═══════════════════════════════════════════╗");
  console.log(`║  LANDMARK #${String(landmarkNumber).padEnd(4)} PUBLISHED                 ║`);
  console.log(`║  Stage: ${finalEval.stage.padEnd(35)}║`);
  console.log(`║  Tier: ${tier.name.padEnd(36)}║`);
  console.log(`║  Art:  ${artBuf ? "yes" : "none".padEnd(36)}║`);
  console.log("╚═══════════════════════════════════════════╝");
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`[landmark] FATAL: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
