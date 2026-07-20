#!/usr/bin/env node
/**
 * runner/article_art.js — Article cover image from a cited source (attributed)
 *
 * Replaced the Imagen 4 generator in the GCP exit (2026-07): covers are no
 * longer AI-generated. Instead, the cover is the og:image of the article's own
 * most relevant cited source — the same pick-and-attribute mechanism the tweet
 * and LinkedIn image paths use (lib/lead_source_image + lib/source_image), so
 * every cover is a real image from a source the article actually cites, with
 * a visible credit line appended to the article.
 *
 * Selection: candidate URLs are the links inside the article markdown (X and
 * self-domain links excluded); relevance is word-overlap against title+excerpt;
 * the page must expose an og:image AND be coherent with the article (og:title/
 * description overlap incl. a proper noun) — an unverifiable image is worse
 * than no image. A miss means no cover: the article ships text-only.
 *
 * Usage:
 *   node runner/article_art.js --date 2026-04-03
 *
 * Output:  articles/images/{date}.png  (bytes may be JPEG/WebP — the .png path
 *          is the website contract, browsers sniff the real type)
 * Also:    appends a "*Cover image via [source](url)*" credit to the article,
 *          and strips legacy inline [IMAGE: …] markers (no longer generated).
 *
 * Called by the article pipeline after the article markdown is written.
 * Skips work if the cover already exists.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const { pickLeadSource } = require("./lib/lead_source_image");
const { fetchSourceImage, cleanup } = require("./lib/source_image");

const ROOT = path.resolve(__dirname, "..");
const ARTICLES_DIR = path.join(ROOT, "articles");
const IMAGES_DIR = path.join(ARTICLES_DIR, "images");

// Own/infra domains never make sense as a cover source.
const SELF_URL_RE =
  /https?:\/\/(?:www\.)?(?:sebastianhunter\.fun|moltbook\.com|gateway\.irys\.xyz|raw\.githubusercontent\.com|github\.com\/mondb-dev)[^\s)\]"']*/gi;

function loadArticle(date) {
  const filePath = path.join(ARTICLES_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) throw new Error(`Article not found: ${filePath}`);

  const raw = fs.readFileSync(filePath, "utf-8");

  // Frontmatter title first (articles ship YAML frontmatter), H1 fallback.
  const fmTitle = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const h1Title = raw.match(/^#\s+(.+)$/m);
  const fmAxis = raw.match(/^axis:\s*["']?(.+?)["']?\s*$/m);
  const axis = fmAxis ? fmAxis[1].trim() : "";
  const title = (fmTitle && fmTitle[1].trim()) || (h1Title && h1Title[1].trim()) || date;

  // Excerpt = first substantive body paragraph, after the frontmatter block.
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  let excerpt = "";
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("-")) continue;
    excerpt = trimmed;
    break;
  }
  return { filePath, raw, title, excerpt, axis };
}

/**
 * Articles cite mostly X posts (excluded as image sources), so the article body
 * alone rarely yields a cover. Widen the candidate pool with the same
 * provenance guarantees, formatted as "context text  URL" note-lines for
 * pickLeadSource — relevance + page-coherence gating stays identical:
 *   1. the article axis's evidence_log sources (the evidence behind the thesis)
 *   2. external (news) URLs carried by recently scraped posts (feed_buffer),
 *      with the post text as relevance context
 */
function fallbackNotes(axisLabel) {
  const lines = [];
  try {
    const onto = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "ontology.json"), "utf-8"));
    const ax = axisLabel && (onto.axes || []).find((a) => (a.label || a.id || "") === axisLabel);
    for (const e of (ax && ax.evidence_log ? ax.evidence_log.slice(-60) : [])) {
      if (e && /^https?:/.test(e.source || "")) {
        lines.push(`${e.summary || e.content || ""} ${e.source}`);
      }
    }
  } catch { /* no ontology — skip */ }

  try {
    const buf = fs.readFileSync(path.join(ROOT, "state", "feed_buffer.jsonl"), "utf-8");
    const rows = buf.trim().split("\n").slice(-1500);
    const cutoff = Date.now() - 72 * 3600 * 1000;
    for (const row of rows) {
      let p;
      try { p = JSON.parse(row); } catch { continue; }
      if (p.ts && p.ts < cutoff) continue;
      for (const u of p.external_urls || []) {
        if (/^https?:/.test(u)) lines.push(`${(p.text || "").slice(0, 300)} ${u}`);
      }
    }
  } catch { /* no buffer — skip */ }

  return lines.join("\n");
}

/**
 * Strip legacy inline [IMAGE: description] markers. Kept as an exported step so
 * the pipeline (and moltbook's "has article_art run yet?" check) still has a
 * marker-free article to work with; we no longer generate inline images.
 */
function processInlineImages(date) {
  const filePath = path.join(ARTICLES_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf-8");
  const updated = raw.replace(/^\[IMAGE:\s*.+?\]\s*$\n?/gm, "");
  if (updated !== raw) {
    fs.writeFileSync(filePath, updated);
    console.log(`[article_art] stripped inline [IMAGE:] markers from ${date}.md`);
    return true;
  }
  return false;
}

function appendCoverCredit(filePath, raw, sourceUrl, sourceLabel) {
  if (raw.includes("Cover image via")) return; // already credited
  const credit = `\n\n---\n\n*Cover image via [${sourceLabel}](${sourceUrl}).*\n`;
  fs.writeFileSync(filePath, fs.readFileSync(filePath, "utf-8").trimEnd() + credit);
  console.log(`[article_art] cover credit appended: ${sourceLabel}`);
}

async function generateCover(date) {
  const coverPath = path.join(IMAGES_DIR, `${date}.png`);
  if (fs.existsSync(coverPath)) {
    console.log(`[article_art] cover already exists: ${coverPath}`);
    return true;
  }

  const { filePath, raw, title, excerpt, axis } = loadArticle(date);
  console.log(`[article_art] picking source cover for: ${title}`);

  // Pass 1 — the article's own citations: the markdown doubles as the "notes"
  // (pickLeadSource extracts each URL with the line it appears on as relevance
  // context). Self links removed first; X links excluded inside pickLeadSource.
  const articleText = `${title}. ${excerpt}`;
  const candidateText = raw.replace(SELF_URL_RE, "");
  let lead = await pickLeadSource(articleText, candidateText, { maxProbe: 5 });

  // Pass 2 — axis evidence + recent scraped-post external URLs, same bar.
  if (!lead) {
    const notes = fallbackNotes(axis).replace(SELF_URL_RE, "");
    if (notes) lead = await pickLeadSource(articleText, notes, { maxProbe: 8 });
  }

  if (!lead) {
    console.log("[article_art] no coherent source with an og:image — article ships without a cover");
    return false;
  }

  const img = await fetchSourceImage(lead.url, { source: lead.source });
  if (!img) {
    console.log(`[article_art] og:image fetch failed for ${lead.url} — no cover`);
    return false;
  }

  try {
    if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.copyFileSync(img.path, coverPath);
    console.log(`[article_art] cover saved: ${coverPath} (via ${lead.source})`);
    appendCoverCredit(filePath, raw, lead.url, lead.source);
    return true;
  } finally {
    cleanup(img.path);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith("--date="));
  const dateArg = eq ? eq.replace("--date=", "") : args[args.indexOf("--date") + 1];
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error("Usage: node runner/article_art.js --date YYYY-MM-DD");
    process.exit(1);
  }

  try {
    processInlineImages(dateArg);
    await generateCover(dateArg);
  } catch (e) {
    // Non-fatal by contract: a missing cover must never block the article pipeline.
    console.error(`[article_art] ${e.message}`);
  }
}

if (require.main === module) main();

module.exports = { processInlineImages };
