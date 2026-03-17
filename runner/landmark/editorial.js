/**
 * runner/landmark/editorial.js — editorial content generator
 *
 * Takes a detected event and generates:
 *   1. Headline (short, punchy — for NFT metadata)
 *   2. Lead statement (1-2 sentences — for NFT description)
 *   3. Full editorial (500-800 words — for Arweave)
 *
 * Uses Vertex AI (Gemini) via runner/vertex.js.
 * Pure content generation — no minting, no uploads.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { callVertex } = require("../vertex");
const { PATHS } = require("./config");

// ── Load ontology context for grounding ───────────────────────────────────────

function loadBeliefContext() {
  try {
    const onto = JSON.parse(fs.readFileSync(PATHS.ONTOLOGY, "utf-8"));
    const axes = (onto.axes || [])
      .filter(a => (a.confidence || 0) > 0.3)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 8);

    return axes.map(a => {
      const dir = (a.score || 0) > 0 ? a.left_pole : a.right_pole;
      return `- ${a.label}: leans toward "${dir}" (${((a.confidence || 0) * 100).toFixed(0)}% confidence)`;
    }).join("\n");
  } catch {
    return "(no belief context available)";
  }
}

// ── Generate editorial ────────────────────────────────────────────────────────

/**
 * Generate headline, lead, and full editorial for a landmark event.
 *
 * @param {object} event - detected event from detect.js
 * @returns {Promise<{headline: string, lead: string, editorial: string}>}
 */
async function generateEditorial(event) {
  const beliefContext = loadBeliefContext();
  const sigList = Object.entries(event.signals)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  const sampleTexts = (event.samplePosts || [])
    .map(p => `@${p.username}: "${p.text}"`)
    .join("\n");

  const prompt = `You are Sebastian D. Hunter — an autonomous AI agent that observes discourse on X/Twitter and forms beliefs through evidence. You've detected a significant convergence event in the discourse you monitor.

## Event data
- Time: ${event.dateStr} UTC
- Posts in window: ${event.postCount}
- Signals fired: ${event.signalCount}/6 [${sigList}]
- Volume z-score: ${event.stats.volumeZ}
- Top keywords: ${event.topKeywords.join(", ")}
- Cross-cluster topics: ${(event.stats.crossClusterTopics || []).map(t => t.keyword).join(", ")}
- Axes impacted: ${(event.stats.axesImpacted || []).join(", ")}

## Sample posts from this window
${sampleTexts}

## Sebastian's current belief axes
${beliefContext}

## Task
Generate three things for this landmark event:

1. **HEADLINE**: A clear, engaging headline (max 80 chars). Not clickbait. States what happened or what shifted. Think newspaper front page, not tweet.

2. **LEAD**: One to two sentences (max 200 chars) expanding on the headline. What does this event mean? Why does it matter?

3. **EDITORIAL**: A 500-800 word editorial written as Sebastian. Requirements:
   - Open with the specific observation that triggered detection
   - Explain what converged: which clusters, what were they saying, why this is unusual
   - Connect to Sebastian's belief axes — how does this event relate to what he's been tracking?
   - Maintain Sebastian's voice: analytical, evidence-based, willing to state a position
   - Close with the implication — what does this convergence signal about what comes next?
   - No hedging everything. State what you actually think.
   - Cite specific posts from the sample data using @username references

## Output format
Respond in exactly this format (no markdown code blocks, just the raw text):

HEADLINE: [your headline]
LEAD: [your lead]
EDITORIAL:
[your editorial text, with markdown formatting for paragraphs]`;

  const response = await callVertex(prompt, 4096);

  // Parse response
  const headlineMatch = response.match(/HEADLINE:\s*(.+)/);
  const leadMatch = response.match(/LEAD:\s*(.+)/);
  const editorialMatch = response.match(/EDITORIAL:\s*\n([\s\S]+)/);

  const headline = headlineMatch
    ? headlineMatch[1].trim().slice(0, 80)
    : `Discourse Convergence: ${event.topKeywords.slice(0, 3).join(", ")}`;

  const lead = leadMatch
    ? leadMatch[1].trim().slice(0, 200)
    : `${event.signalCount} independent signals fired simultaneously across ${event.postCount} posts.`;

  const editorial = editorialMatch
    ? editorialMatch[1].trim()
    : null;

  if (!editorial || editorial.length < 200) {
    throw new Error("Editorial generation failed — response too short");
  }

  return { headline, lead, editorial };
}

/**
 * Build the full Arweave HTML document for permanent storage.
 *
 * @param {object} event - detected event
 * @param {object} content - { headline, lead, editorial }
 * @returns {string} HTML document
 */
function buildArweaveHtml(event, content) {
  const dateStr = new Date(event.date).toISOString().slice(0, 10);
  const sigList = Object.entries(event.signals)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="x-hunter-type" content="landmark">
  <meta name="x-hunter-date" content="${dateStr}">
  <meta name="x-hunter-signals" content="${event.signalCount}/6">
  <title>${content.headline} — Sebastian D. Hunter</title>
  <style>
    body { font-family: Georgia, serif; max-width: 680px; margin: 2em auto; padding: 0 1em; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 1.8em; margin-bottom: 0.2em; }
    .lead { font-size: 1.1em; color: #555; font-style: italic; margin-bottom: 2em; }
    .meta { color: #888; font-size: 0.85em; margin-bottom: 1em; }
    .signals { background: #f5f5f5; padding: 0.8em 1em; border-radius: 4px; font-size: 0.85em; margin: 1.5em 0; }
    .signals strong { color: #333; }
    footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid #eee; font-size: 0.8em; color: #999; }
  </style>
</head>
<body>
  <article>
    <h1>${escapeHtml(content.headline)}</h1>
    <p class="lead">${escapeHtml(content.lead)}</p>
    <p class="meta">${dateStr} · Sebastian D. Hunter · @SebastianHunts</p>
    <div class="signals">
      <strong>Detection signals:</strong> ${event.signalCount}/6 [${sigList}]<br>
      <strong>Posts analyzed:</strong> ${event.postCount} in 2-hour window<br>
      <strong>Top keywords:</strong> ${event.topKeywords.join(", ")}
    </div>
    ${markdownToHtml(content.editorial)}
  </article>
  <footer>
    <p>This editorial was generated autonomously by Sebastian D. Hunter, an AI agent that forms beliefs through direct observation of public discourse. Every belief is tracked, scored, and permanently archived.</p>
    <p>Landmark #${event.landmarkNumber || "?"} · Detected ${event.dateStr} UTC</p>
  </footer>
</body>
</html>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal markdown → HTML (paragraphs, bold, italic, links) */
function markdownToHtml(md) {
  return md
    .split(/\n\n+/)
    .map(para => {
      let html = para.trim();
      if (!html) return "";
      // Bold
      html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      // Italic
      html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
      // Links
      html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
      // Line breaks within paragraph
      html = html.replace(/\n/g, "<br>");
      return `<p>${html}</p>`;
    })
    .filter(Boolean)
    .join("\n    ");
}

module.exports = { generateEditorial, buildArweaveHtml };
