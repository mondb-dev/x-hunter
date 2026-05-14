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

const STUDIES = [
  {
    name: "logo_32bit",
    prompt: [
      "Pixel art illustration, polished 32-bit SNES sprite aesthetic,",
      "clean crisp pixel clusters, smooth readable silhouette, carefully dithered shading,",
      "limited palette, no anti-aliasing. Square composition 1:1.",
      "Chibi kawaii proportions: oversized round dome head taking up half the body height,",
      "tiny stubby arms and legs, compact torso, full body visible from head to toe.",
      "Tight centered composition — character fills most of the frame, minimal negative space.",
      "Solid flat near-black background #0a0b0c, no backdrop scenery, no desert, no environment.",
      "Small cute robot field investigator. Oversized round dome head, large oval visor eyes glowing warm amber #d4a830.",
      "Wide-brim fedora hat, worn dusty tan with a plain band and a single decorative feather tucked in,",
      "earthy brown feather with pale ivory tip.",
      "Rugged trench coat, faded khaki-sand, dithered shading, chest pocket flaps, belt loosely tied.",
      "Short stubby legs, heavy round boots. Upright confident stance, arms slightly relaxed at sides.",
      "Sand, khaki, amber glow palette. Premium polished 32-bit sprite, clean icon-ready composition.",
    ].join(" "),
  },
];


async function generateImage(prompt, outputPath) {
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();
  const model = "imagen-4.0-generate-001";
  const apiPath = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;

  const body = JSON.stringify({
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: "1:1",
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
      await generateImage(s.prompt, out);
      console.log(`saved → ${out}`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
  console.log("\nDone. Open /tmp/avatar_study_*.png to review.");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
