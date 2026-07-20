/**
 * runner/landmark/art.js — Hero art generation via the Gemini web app
 *
 * Generates a hero image for a landmark editorial by driving the signed-in
 * gemini.google.com session in the HelmStack browser (helmstack-social Gemini
 * engine). Replaced Imagen 4 / Vertex AI in the GCP exit (2026-07): no API key,
 * no billing — uses the Google account signed into the browser profile.
 *
 * Style: Pixel art (primary) — see docs/IMAGE_STYLE.md for canonical rules.
 * Human figures are faceless silhouettes. No text/lettering. No national symbols.
 * Action-oriented composition. Accurate depiction of topic (era, geography, objects).
 *
 * Returns a Buffer of PNG image data (16:9-ish; the web app decides exact size).
 * Throws on failure, same as the Imagen version — callers already treat hero
 * art as non-fatal.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { LANDMARK_TIERS } = require("./config");
const { STYLE_DIRECTIVE } = require("../image_style");
const { HelmStackClient, Gemini } = require("../../tools/helmstack-social/src");

// Style rules: docs/IMAGE_STYLE.md + runner/image_style.js

/**
 * @param {object} event
 * @param {string} event.headline
 * @param {string[]} event.topKeywords - top keywords from the event
 * @param {number} event.signalCount
 * @param {string} [event.landmarkTierKey]
 * @returns {string} prompt for the image model
 */
function buildArtPrompt(event) {
  const tier = LANDMARK_TIERS[event.landmarkTierKey] || LANDMARK_TIERS.tier_2;
  const keywords = (event.topKeywords || []).slice(0, 5).join(", ");
  const tierMood = {
    "Tier 2": "cool, atmospheric, steely blue tones, tension building",
    "Tier 1": "dramatic, high contrast, urgent energy, forces in motion",
    Special: "reflective, transformative, significant shift underway",
    Prediction: "ominous, alert, structural forces colliding",
  };

  return [
    STYLE_DIRECTIVE,
    `Accurate depiction of the discourse topic: ${keywords}.`,
    event.headline ? `Scene based on: ${event.headline}.` : "",
    "Show era-accurate geography, vehicles, objects, or animals relevant to the topic.",
    "Action-oriented — forces in motion, objects being operated, conditions changing.",
    `Mood and palette: ${tierMood[tier.name] || "contemplative, forces at play"}.`,
    "Wide cinematic composition, 16:9 aspect ratio.",
    "Polished premium pixel art, cohesive pixel clusters, readable focal subject, no blurry anti-aliasing.",
  ].filter(Boolean).join(" ");
}

/**
 * Generate hero art via the Gemini web app (HelmStack-driven).
 *
 * @param {object} event - the landmark event object
 * @param {object} [opts]
 * @param {string} [opts.outputPath] - if set, write PNG to this path
 * @returns {Promise<{buffer: Buffer, prompt: string}>}
 */
async function generateHeroArt(event, opts = {}) {
  const prompt = buildArtPrompt(event);
  console.log(`[art] Generating hero art via Gemini web: ${prompt.slice(0, 120)}...`);

  const gemini = new Gemini(new HelmStackClient());
  const result = await gemini.generateImage(prompt);
  if (!result) throw new Error("Gemini web image generation returned nothing (quota, sign-in, or timeout — see [gemini] logs)");

  if (opts.outputPath) {
    const dir = path.dirname(opts.outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(opts.outputPath, result.buffer);
    console.log(`[art] Saved hero art: ${opts.outputPath} (${(result.buffer.length / 1024).toFixed(0)} KB)`);
  }

  return { buffer: result.buffer, prompt };
}

module.exports = { generateHeroArt, buildArtPrompt };
