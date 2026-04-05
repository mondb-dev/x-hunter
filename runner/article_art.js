#!/usr/bin/env node
/**
 * runner/article_art.js — Article cover image generator via Imagen 4 (Vertex AI)
 *
 * Generates a 16:9 pixel art cover image for a sprint article.
 * Style rules: docs/IMAGE_STYLE.md
 *
 * Usage:
 *   node runner/article_art.js --date 2026-04-03
 *
 * Output: articles/images/{date}.png
 *
 * Called by the article pipeline after the article markdown is written.
 * Skips generation if the image already exists.
 */

"use strict";

const fs   = require("fs");
const https = require("https");
const path = require("path");
const { getAccessToken, getProjectConfig } = require("./gcp_auth");
const { STYLE_DIRECTIVE } = require("./image_style");

// Style rules: docs/IMAGE_STYLE.md + runner/image_style.js

const ROOT         = path.join(__dirname, "..");
const ARTICLES_DIR = path.join(ROOT, "articles");
const IMAGES_DIR   = path.join(ARTICLES_DIR, "images");

// ── Prompt builder ─────────────────────────────────────────────────────────────

/**
 * Build an Imagen prompt for an article.
 *
 * @param {object} article
 * @param {string} article.title
 * @param {string} [article.axis]      - belief axis label (e.g. "discourse order vs polarization")
 * @param {string} [article.excerpt]   - first substantive paragraph of the article
 * @returns {string}
 */
function buildArticleArtPrompt(article) {
  // If a concrete scene is provided, use it directly.
  // Otherwise derive from title + excerpt, but strip obviously abstract phrases.
  let sceneDirective;
  if (article.scene) {
    sceneDirective = `Scene: ${article.scene}.`;
  } else {
    // Filter out overly abstract excerpts — they push Imagen toward people-at-screens
    const excerptIsVisual = article.excerpt &&
      /\b(war|battle|flood|fire|ship|vessel|missile|drone|crowd|city|market|border|factory|port|oil|gas|protest|soldier|aircraft|satellite|storm|forest|desert|ocean|river|mountain|building|bridge|road|vehicle|tank|soldier|troops|election|vote|court|prison|wall|fence|cable|data center|mine|pipeline)\b/i.test(article.excerpt);

    const subjectParts = [
      article.title ? `Scene inspired by: "${article.title}".` : "",
      excerptIsVisual
        ? `Visual elements from the article: ${article.excerpt.slice(0, 160).replace(/\n/g, " ")}`
        : "",
      article.axis
        ? `Thematic context: ${article.axis.replace(/_/g, " ")}.`
        : "",
    ].filter(Boolean);

    // Fallback for abstract articles: a concrete editorial default
    if (!excerptIsVisual) {
      subjectParts.push(
        "Editorial scene: a large public square at night, searchlights scanning across buildings, " +
        "surveillance cameras on poles, news broadcast antennas, satellite dishes, cables running between structures. " +
        "No people. Focus on infrastructure and architecture."
      );
    }

    sceneDirective = subjectParts.join(" ");
  }

  return [
    STYLE_DIRECTIVE,
    sceneDirective,
    "Accurate depiction — show era-correct geography, vehicles, objects, or animals relevant to the topic.",
    "Action-oriented composition — forces in motion, objects being operated, conditions actively changing.",
    "Wide cinematic framing, 16:9 aspect ratio.",
    "Polished premium pixel art, cohesive pixel clusters, readable focal subject, no blurry anti-aliasing.",
    "IMPORTANT: absolutely no text, no words, no letters, no numbers anywhere in the image.",
  ].filter(Boolean).join(" ");
}

// ── Imagen 4 API call ──────────────────────────────────────────────────────────

async function generateImage(prompt) {
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();
  const model   = "imagen-4.0-generate-001";
  const apiPath = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;

  console.log(`[article_art] Prompt: ${prompt.slice(0, 120)}...`);

  const body = JSON.stringify({
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: "16:9",
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
}

// ── Article loader ─────────────────────────────────────────────────────────────

function loadArticle(date) {
  const filePath = path.join(ARTICLES_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) throw new Error(`Article not found: ${filePath}`);

  const raw = fs.readFileSync(filePath, "utf-8");

  // Extract title from first H1
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : date;

  // Extract first substantive paragraph (skip headings and blank lines)
  const lines = raw.split("\n");
  let excerpt = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("-")) continue;
    excerpt = trimmed;
    break;
  }

  // Try to extract axis from frontmatter (gray-matter style) or filename pattern
  const axisMatch = raw.match(/^axis:\s*(.+)$/m);
  const axis = axisMatch ? axisMatch[1].trim() : "";

  return { title, excerpt, axis, date };
}

// ── Inline image processor ─────────────────────────────────────────────────────

/**
 * Find [IMAGE: description] markers in article markdown, generate an image for
 * each, save to articles/images/{date}-{n}.png, and rewrite the article file
 * with proper markdown image tags.
 *
 * Returns the count of images generated.
 */
async function processInlineImages(date) {
  const articlePath = path.join(ARTICLES_DIR, `${date}.md`);
  if (!fs.existsSync(articlePath)) return 0;

  const raw = fs.readFileSync(articlePath, "utf-8");
  const MARKER_RE = /^\[IMAGE:\s*(.+?)\]\s*$/gm;
  const markers = [...raw.matchAll(MARKER_RE)];
  if (markers.length === 0) return 0;

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  let updated = raw;
  let generated = 0;

  for (let i = 0; i < markers.length; i++) {
    const [fullMatch, description] = markers[i];
    const imgName = `${date}-${i + 1}.png`;
    const outputPath = path.join(IMAGES_DIR, imgName);
    const webPath = `/images/articles/${imgName}`;

    // Already generated — just make sure the marker is replaced
    if (fs.existsSync(outputPath)) {
      console.log(`[article_art] inline image ${imgName} already exists — skipping generation`);
    } else {
      console.log(`[article_art] generating inline image ${i + 1}/${markers.length}: ${description.slice(0, 80)}`);
      const prompt = buildArticleArtPrompt({ title: description, scene: description, date });
      try {
        const buffer = await generateImage(prompt);
        fs.writeFileSync(outputPath, buffer);
        console.log(`[article_art] saved inline image: ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
        generated++;
      } catch (err) {
        console.warn(`[article_art] inline image ${i + 1} failed: ${err.message} — leaving marker`);
        continue;
      }
    }

    // Replace marker with markdown image tag
    updated = updated.replace(
      fullMatch,
      `\n![${description.slice(0, 80)}](${webPath})\n`,
    );
  }

  if (updated !== raw) {
    fs.writeFileSync(articlePath, updated);
    console.log(`[article_art] rewrote article with ${markers.length} inline image(s)`);
  }

  return generated;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.find(a => a.startsWith("--date="))?.replace("--date=", "")
    || args[args.indexOf("--date") + 1];

  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error("Usage: node runner/article_art.js --date YYYY-MM-DD");
    process.exit(1);
  }

  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // ── Cover image ──────────────────────────────────────────────────────────────
  const coverPath = path.join(IMAGES_DIR, `${dateArg}.png`);

  if (fs.existsSync(coverPath)) {
    console.log(`[article_art] cover image already exists: ${coverPath} — skipping.`);
  } else {
    // Optional --scene "description" to override the auto-derived scene
    const sceneIdx = args.indexOf("--scene");
    const scene = sceneIdx !== -1 ? args[sceneIdx + 1] : undefined;

    const article = { ...loadArticle(dateArg), scene };
    console.log(`[article_art] generating cover for: ${article.title}`);

    const prompt = buildArticleArtPrompt(article);
    const buffer = await generateImage(prompt);
    fs.writeFileSync(coverPath, buffer);
    console.log(`[article_art] cover saved: ${coverPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  }

  // ── Inline images ────────────────────────────────────────────────────────────
  await processInlineImages(dateArg);
}

main().catch(err => {
  console.error("[article_art] Error:", err.message);
  process.exit(1);
});

module.exports = { buildArticleArtPrompt, processInlineImages };
