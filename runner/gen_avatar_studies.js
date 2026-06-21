#!/usr/bin/env node
/**
 * Generates 4 avatar concept studies for Sebastian D. Hunter rebrand.
 * Run: node runner/gen_avatar_studies.js
 * Output: /tmp/avatar_study_1.png ... /tmp/avatar_study_4.png
 */

"use strict";

const fs    = require("fs");
const https = require("https");
const path  = require("path");
const { getAccessToken, getProjectConfig } = require("./gcp_auth");

const BASE = [
  "Pixel art illustration, handcrafted 32-bit era aesthetic,",
  "chunky pixel clusters, visible pixel grid, crisp hard edges,",
  "limited intentional color palette, no text, no lettering, no logos.",
  "Square composition 1:1.",
].join(" ");

const CHIBI = [
  "Chibi kawaii proportions: oversized round dome head taking up half the body height,",
  "tiny stubby arms and legs, compact torso, full body visible from head to toe.",
  "Centered on dark near-black background #0a0b0c.",
  "Cute friendly mood, round soft silhouette, charming and approachable.",
].join(" ");

const GHOST_BASE = [
  "Pixel art illustration, polished 32-bit SNES sprite aesthetic,",
  "clean crisp pixel clusters, smooth readable silhouette, carefully dithered shading,",
  "limited palette, hard pixel edges, no anti-aliasing. Square composition 1:1.",
  "Chibi kawaii proportions: oversized round dome head, tiny stubby arms and legs, full body visible.",
  "Tight centered composition, solid near-black background #0a0b0c.",
  "Small cute robot field investigator — round dome head, wide-brim fedora hat with feather, trench coat.",
].join(" ");

const STUDIES = [
  {
    name: "ghost_1_ethereal",
    prompt: [
      GHOST_BASE,
      "Ghostly ethereal style: body rendered as semi-transparent pale ice-blue #a8d0f0,",
      "soft glowing white-blue outline radiating outward as if made of frozen mist,",
      "wispy translucent coat trails dissolving into light at the hem edges,",
      "eyes glowing soft white-cyan #c8f0ff, face faintly luminous.",
      "Palette: pale ice blue, ghostly white, faint cyan glow. Serene haunted mood.",
    ].join(" "),
  },
  {
    name: "ghost_2_spectral",
    prompt: [
      GHOST_BASE,
      "Spectral haunted style: body rendered in eerie terminal green #00ff88 tones,",
      "glitchy scanline dithering texture across the coat and head,",
      "eyes blazing bright toxic green #00ff44 with flicker glow effect,",
      "dark moss-green shadows, neon green outline, spirit-energy wisps rising from shoulders.",
      "Palette: deep black-green, bright terminal green, toxic glow. Haunted digital ghost mood.",
    ].join(" "),
  },
  {
    name: "ghost_3_void",
    prompt: [
      GHOST_BASE,
      "Dark void phantom style: body near-invisible deep charcoal #1a1a2a,",
      "defined only by a sharp electric violet #9060ff glowing outline,",
      "eyes two burning violet orbs #b080ff casting upward light on the hat brim,",
      "coat dissolves into darkness at edges, small floating void particles orbiting the body.",
      "Palette: near-black void, electric violet glow, deep purple shadow. Silent phantom mood.",
    ].join(" "),
  },
  {
    name: "ghost_4_amber_spirit",
    prompt: [
      GHOST_BASE,
      "Amber spirit style: body warm sepia-gold #c8a060, like an old photograph come to life,",
      "soft warm amber #e09020 glow outlining the whole silhouette,",
      "eyes deep burning amber #ff9900 with warm flickering light,",
      "coat edges dissolve into golden embers and fading light trails,",
      "slight warmth and nostalgia — a spirit that lingers, not menacing.",
      "Palette: sepia gold, warm amber glow, burnt orange shadow. Nostalgic ghost mood.",
    ].join(" "),
  },
];


async function generateImage(prompt, outputPath, aspectRatio = "1:1") {
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();
  const model = "imagen-4.0-generate-001";
  const apiPath = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;

  const body = JSON.stringify({
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio,
      safetySetting: "block_only_high",
    },
  });

  return new Promise((resolve, reject) => {
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
          if (j.error) throw new Error(`Imagen error: ${JSON.stringify(j.error).slice(0, 300)}`);
          if (!j.predictions?.[0]?.bytesBase64Encoded) throw new Error(`No image in response: ${raw.slice(0, 200)}`);
          const buf = Buffer.from(j.predictions[0].bytesBase64Encoded, "base64");
          fs.writeFileSync(outputPath, buf);
          resolve(outputPath);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`Generating ${STUDIES.length} avatar studies via Imagen 4...\n`);
  for (const s of STUDIES) {
    const out = `branding/${s.name}.png`;
    process.stdout.write(`[${s.name}] generating... `);
    try {
      await generateImage(s.prompt, out, s.aspectRatio || "1:1");
      console.log(`saved → ${out}`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
  console.log("\nDone. Open /tmp/avatar_study_*.png to review.");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
