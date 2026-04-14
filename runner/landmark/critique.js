/**
 * runner/landmark/critique.js — Gemini-based article critique + meta proposals
 *
 * Runs after a landmark article is published. Evaluates the editorial on:
 *   1. Evidence groundedness — are claims traceable to sample posts?
 *   2. Vocation alignment — does the lens reflect Sebastian's stated purpose?
 *   3. Voice consistency — analytical, direct, willing to take a position?
 *   4. Headline quality — does it earn the read without fabricating?
 *
 * Also generates a "meta proposal" — threads from the article that Sebastian
 * should investigate further in future browse cycles.
 *
 * Outputs:
 *   landmarks/landmark_N/critique.md  — full critique for the article record
 *   state/article_meta.md             — meta proposal, read by browse agent
 *
 * Uses llm.generate() (Gemini Flash via Vertex AI) — no Ollama dependency.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { generate: llmGenerate } = require("../llm");
const { PATHS } = require("./config");

const ARTICLE_META_PATH = path.join(PATHS.ROOT, "state", "article_meta.md");

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildCritiquePrompt(event, content, vocationContext) {
  const sampleTexts = (event.samplePosts || [])
    .map(p => `@${p.username}: "${p.text}"`)
    .join("\n");

  return `You are an editorial critic reviewing a piece written by an autonomous AI agent named Sebastian D. Hunter. Your job is to give direct, honest feedback. No flattery.

## Sebastian's vocation
${vocationContext || "(not defined)"}

## Source material (posts the article was based on)
${sampleTexts || "(none available)"}

## Published article
HEADLINE: ${content.headline}
LEAD: ${content.lead}

EDITORIAL:
${content.editorial}

---

Evaluate on exactly these four criteria. Be strict and brief. Use this exact format:

EVIDENCE: [Strong / Adequate / Weak] — are the claims grounded in the sample posts? Does it fabricate or extrapolate beyond what the posts actually say?

VOCATION: [Strong / Adequate / Weak] — does the piece reflect Sebastian's role as a watchdog for disinformation and institutional deceit? Or does it drift into generic commentary?

VOICE: [Strong / Adequate / Weak] — is it analytical, direct, willing to take a position? Or does it hedge and generalise?

HEADLINE: [Strong / Adequate / Weak] — does the headline earn the read without fabricating an event?

GAPS: One sentence. What specific thing is missing or weak that the next article should address?

META PROPOSAL: Two to three sentences. Based on what emerged in this article, what thread should Sebastian specifically investigate in future browse cycles? Name concrete angles, accounts, or claims worth tracking — not generic advice.`;
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parseField(text, field) {
  const m = text.match(new RegExp(`${field}:\\s*(.+?)(?:\\n|$)`, "i"));
  return m ? m[1].trim() : null;
}

function parseMetaProposal(text) {
  const m = text.match(/META PROPOSAL:\s*([\s\S]+?)(?:\n[A-Z ]+:|$)/i);
  return m ? m[1].trim() : null;
}

// ── Load vocation ─────────────────────────────────────────────────────────────

function loadVocationContext() {
  try {
    const vocPath = path.join(PATHS.ROOT, "state", "vocation.json");
    const voc = JSON.parse(fs.readFileSync(vocPath, "utf-8"));
    const label     = voc.label     || null;
    const statement = voc.statement || voc.description || null;
    if (!label && !statement) return null;
    const parts = [];
    if (label)     parts.push(`Role: ${label}`);
    if (statement) parts.push(`Voice: "${statement}"`);
    return parts.join("\n");
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Critique a published landmark article and generate a meta proposal.
 *
 * @param {object} event        - landmark event object
 * @param {object} content      - { headline, lead, editorial }
 * @param {object} opts
 * @param {number} opts.landmarkNumber
 * @param {string} [opts.outputDir] - override output directory
 * @returns {Promise<{evidence, vocation, voice, headline, gaps, metaProposal, raw}>}
 */
async function critiqueArticle(event, content, opts = {}) {
  const lnum      = opts.landmarkNumber || event.landmarkNumber || "?";
  const outputDir = opts.outputDir || path.join(PATHS.LANDMARKS_DIR, `landmark_${lnum}`);
  const voc       = loadVocationContext();
  const prompt    = buildCritiquePrompt(event, content, voc);

  console.log(`[critique] evaluating landmark #${lnum} article via Gemini...`);

  let raw;
  try {
    raw = await llmGenerate(prompt, { temperature: 0.2, maxTokens: 600, timeoutMs: 60_000 });
  } catch (err) {
    console.warn(`[critique] Gemini call failed: ${err.message} — skipping`);
    return null;
  }

  if (!raw || raw.length < 50) {
    console.warn("[critique] empty response — skipping");
    return null;
  }

  const evidence     = parseField(raw, "EVIDENCE");
  const vocation     = parseField(raw, "VOCATION");
  const voice        = parseField(raw, "VOICE");
  const headline     = parseField(raw, "HEADLINE");
  const gaps         = parseField(raw, "GAPS");
  const metaProposal = parseMetaProposal(raw);

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");

  // ── Write landmark critique record ────────────────────────────────────────

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const critiqueMd = [
    `# Article Critique · Landmark #${lnum} · ${timestamp}`,
    "",
    raw,
    "",
    "---",
    `*Landmark #${lnum} · ${event.topKeywords?.slice(0, 3).join(", ") || ""}*`,
    "",
  ].join("\n");

  const critiquePath = path.join(outputDir, "critique.md");
  fs.writeFileSync(critiquePath, critiqueMd);
  console.log(`[critique] wrote ${critiquePath}`);

  // ── Write article_meta.md for browse agent pickup ─────────────────────────

  if (metaProposal) {
    const metaMd = [
      `# Article Meta Proposal · Landmark #${lnum} · ${timestamp}`,
      "",
      `From the published article on: **${content.headline}**`,
      "",
      metaProposal,
      "",
      gaps ? `**Gap to address:** ${gaps}` : "",
      "",
    ].join("\n").replace(/\n{3,}/g, "\n\n");

    fs.writeFileSync(ARTICLE_META_PATH, metaMd);
    console.log(`[critique] meta proposal written → state/article_meta.md`);
  }

  // Console summary
  const line = "─".repeat(60);
  console.log(`[critique] ${line}`);
  console.log(`[critique] LANDMARK #${lnum} ARTICLE CRITIQUE`);
  console.log(`[critique] Evidence: ${evidence || "?"}  Vocation: ${vocation || "?"}  Voice: ${voice || "?"}  Headline: ${headline || "?"}`);
  if (gaps) console.log(`[critique] Gap: ${gaps}`);
  if (metaProposal) console.log(`[critique] Meta: ${metaProposal.slice(0, 120)}...`);
  console.log(`[critique] ${line}`);

  return { evidence, vocation, voice, headline, gaps, metaProposal, raw };
}

module.exports = { critiqueArticle };
