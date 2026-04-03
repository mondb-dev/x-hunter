/**
 * runner/landmark/art.js — Hero art generation via Imagen 4 (Vertex AI)
 *
 * Generates a hero image for a landmark editorial using Google's
 * Imagen 4 model via Vertex AI.
 *
 * Style: Pixel art (primary) — see docs/IMAGE_STYLE.md for canonical rules.
 * Human figures are faceless silhouettes. No text/lettering. No national symbols.
 * Action-oriented composition. Accurate depiction of topic (era, geography, objects).
 *
 * Returns a Buffer of PNG image data (16:9).
 */

"use strict";

const fs    = require("fs");
const https = require("https");
const path  = require("path");
const { LANDMARK_TIERS } = require("./config");
const { getAccessToken, getProjectConfig } = require("../gcp_auth");
const { STYLE_DIRECTIVE } = require("../image_style");

// Style rules: docs/IMAGE_STYLE.md + runner/image_style.js

/**
 * @param {object} event
 * @param {string} event.headline
 * @param {string[]} event.topKeywords - top keywords from the event
 * @param {number} event.signalCount
 * @param {string} [event.landmarkTierKey]
 * @returns {string} prompt for Imagen
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

// ── Imagen 4 API call (Vertex AI) ────────────────────────────────────────────

/**
 * Generate hero art using Imagen 4 via Vertex AI.
 *
 * @param {object} event - the landmark event object
 * @param {object} [opts]
 * @param {string} [opts.outputPath] - if set, write PNG to this path
 * @returns {Promise<{buffer: Buffer, prompt: string}>}
 */
async function generateHeroArt(event, opts = {}) {
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();
  const model = "imagen-4.0-generate-001";
  const prompt = buildArtPrompt(event);
  console.log(`[art] Generating hero art with prompt: ${prompt.slice(0, 120)}...`);

  const apiPath = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;

  const body = JSON.stringify({
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: "16:9",
      personGeneration: "allow_adult",
      safetySetting: "block_some",
    },
  });

  const imageBuffer = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${location}-aiplatform.googleapis.com`,
      path: apiPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const j = JSON.parse(raw);
          if (j.error) throw new Error(`Imagen API error: ${JSON.stringify(j.error).slice(0, 300)}`);
          const predictions = j.predictions;
          if (!predictions || !predictions[0]?.bytesBase64Encoded) {
            throw new Error(`No image in response: ${raw.slice(0, 300)}`);
          }
          resolve(Buffer.from(predictions[0].bytesBase64Encoded, "base64"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (opts.outputPath) {
    const dir = path.dirname(opts.outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(opts.outputPath, imageBuffer);
    console.log(`[art] Saved hero art: ${opts.outputPath} (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
  }

  return { buffer: imageBuffer, prompt };
}

module.exports = { generateHeroArt, buildArtPrompt };
