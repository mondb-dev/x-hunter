/**
 * runner/landmark/art.js — Hero art generation via Imagen 4 (Vertex AI)
 *
 * Generates a hero image for a landmark editorial using Google's
 * Imagen 4 model via Vertex AI.
 *
 * Style: Vintage 1960s movie poster, painted illustration.
 * Any human figures are rendered as faceless silhouettes.
 * No text/lettering in the image — all titling is separate.
 *
 * Returns a Buffer of PNG image data (16:9).
 */

"use strict";

const fs    = require("fs");
const https = require("https");
const path  = require("path");
const { CARD_TIERS } = require("./config");
const { getAccessToken, getProjectConfig } = require("../gcp_auth");

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the Imagen prompt from event data.
 *
 * Style: Editorial illustration — compelling, atmospheric, conceptual.
 * Figures are faceless when present. No text/lettering in the image.
 * Must visually represent the ACTUAL discourse topic, not a fabricated scene.
 */
const STYLE_DIRECTIVE = [
  "Editorial illustration, atmospheric and conceptual,",
  "dramatic cinematic composition, rich color palette,",
  "painterly digital art with subtle texture,",
  "any human figures MUST be faceless silhouettes with no facial features,",
  "absolutely no text, no lettering, no words, no numbers, no logos,",
  "no title cards, no credits — the image is pure illustration only.",
].join(" ");

/**
 * @param {object} event
 * @param {string} event.headline
 * @param {string[]} event.topKeywords - top keywords from the event
 * @param {number} event.signalCount
 * @returns {string} prompt for Imagen
 */
function buildArtPrompt(event) {
  const tier = CARD_TIERS[Math.min(Math.max(event.signalCount, 3), 6)];
  const keywords = (event.topKeywords || []).slice(0, 5).join(", ");
  const tierMood = {
    Bronze: "contemplative, muted tones, understated tension",
    Silver: "cool, atmospheric, steely blue tones, tension rising",
    Gold:   "dramatic, high contrast, luminous, urgent energy",
  };

  return [
    STYLE_DIRECTIVE,
    `Abstract conceptual scene representing a discourse about: ${keywords}.`,
    event.headline ? `Theme: ${event.headline}.` : "",
    `Mood and palette: ${tierMood[tier.name] || "contemplative"}.`,
    "Wide cinematic composition (16:9 aspect ratio).",
    "Symbolic and metaphorical — NOT a literal depiction of news events.",
    "Think magazine cover illustration, abstract enough to be universal.",
    "High detail, 4K quality.",
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
      personGeneration: "dont_allow",
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
