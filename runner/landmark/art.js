/**
 * runner/landmark/art.js — Hero art generation via Vertex AI Imagen 3
 *
 * Generates a hero image for a landmark event card using Google's
 * Imagen 3 model via the Vertex AI predict endpoint.
 *
 * The prompt is constructed from the event data (headline, topics,
 * tier) and a house style directive. The final prompt template
 * is a placeholder — user will finalize before enabling.
 *
 * Returns a Buffer of PNG image data (1024×1024).
 */

"use strict";

const fs    = require("fs");
const https = require("https");
const path  = require("path");
const { CARD_TIERS } = require("./config");

// Reuse the Vertex auth from vertex.js
const ROOT = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(ROOT, ".env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ── Auth (reuse JWT from vertex.js) ───────────────────────────────────────────

// We import callVertex's parent module to access the token getter.
// But since getAccessToken isn't exported, we replicate minimal auth here.
// TODO: consider refactoring vertex.js to export getAccessToken.

const crypto = require("crypto");

let _cachedToken = null;
let _tokenExpiry = 0;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss:   serviceAccount.client_email,
    sub:   serviceAccount.client_email,
    aud:   "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    iat:   now,
    exp:   now + 3600,
  })));
  const unsigned = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const sig = base64url(sign.sign(serviceAccount.private_key));
  return `${unsigned}.${sig}`;
}

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) throw new Error("GOOGLE_APPLICATION_CREDENTIALS not set");
  const sa = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  const jwt  = makeJwt(sa);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          if (!j.access_token) throw new Error(`Token exchange failed: ${raw.slice(0, 200)}`);
          _cachedToken = j.access_token;
          _tokenExpiry = Date.now() + (j.expires_in - 60) * 1000;
          resolve(_cachedToken);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the Imagen prompt from event data.
 *
 * IMPORTANT: This prompt template is a PLACEHOLDER.
 * The user wants to finalize the artwork style before enabling.
 * Update STYLE_DIRECTIVE and PROMPT_TEMPLATE when ready.
 */
const STYLE_DIRECTIVE = [
  "Digital illustration, dark moody atmosphere, cinematic lighting,",
  "abstract data visualization aesthetic, dark navy and deep purple tones,",
  "subtle geometric patterns, glowing accents, no text, no words,",
  "no letters, no numbers, suitable as trading card hero art.",
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
    Silver: "calm, distant, analytical",
    Gold: "warm, significant, resonant",
    Prismatic: "intense, prismatic light refractions, electric",
    Obsidian: "overwhelming, monumental, golden cracks in obsidian darkness",
  };

  return [
    STYLE_DIRECTIVE,
    `Theme: ${event.headline}.`,
    keywords ? `Visual motifs inspired by: ${keywords}.` : "",
    `Mood: ${tierMood[tier.name] || "contemplative"}.`,
    `Color palette emphasizing ${tier.frame} accents on dark background.`,
    "Wide composition suitable for cropping to 560×340 card art area.",
    "High detail, 4K quality.",
  ].filter(Boolean).join(" ");
}

// ── Imagen 3 API call ─────────────────────────────────────────────────────────

/**
 * Generate hero art using Vertex AI Imagen 3.
 *
 * @param {object} event - the landmark event object
 * @param {object} [opts]
 * @param {string} [opts.outputPath] - if set, write PNG to this path
 * @returns {Promise<{buffer: Buffer, prompt: string}>}
 */
async function generateHeroArt(event, opts = {}) {
  const token   = await getAccessToken();
  const project = process.env.VERTEX_PROJECT_ID || "sebastian-hunter";
  const location = process.env.VERTEX_LOCATION  || "us-central1";
  const model   = "imagen-3.0-generate-002";

  const prompt = buildArtPrompt(event);
  console.log(`[art] Generating hero art with prompt: ${prompt.slice(0, 120)}...`);

  const apiPath = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;

  const body = JSON.stringify({
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: "16:9",       // closest to 560×340 card art ratio
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
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
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
    console.log(`[art] Saved hero art: ${opts.outputPath}`);
  }

  return { buffer: imageBuffer, prompt };
}

module.exports = { generateHeroArt, buildArtPrompt };
