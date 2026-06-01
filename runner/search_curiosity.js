#!/usr/bin/env node
/**
 * runner/search_curiosity.js — web-search expansion for curiosity directives
 *
 * Reads the current curiosity_directive.txt, extracts the RESEARCH FOCUS topic,
 * runs a grounded Gemini web search, and adds the top 3 result URLs to
 * state/reading_queue.jsonl. This gives the browse agent actual web sources
 * to visit — not just X posts about the topic.
 *
 * Gate: only runs when a fresh directive was just written (state/curiosity_hint_ts.txt
 * tracks last directive write time). Max 3 URLs per directive cycle. Skips if the
 * directive is unchanged since last run.
 *
 * State: state/search_curiosity_state.json
 *        { "last_directive_hash": "...", "last_run": "ISO" }
 *
 * Usage: node runner/search_curiosity.js
 * Called from run.sh immediately after curiosity.js (non-fatal).
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const config = require("./lib/config");
const { getTokenForKey, getProjectConfig } = require("./gcp_auth.js");

const ROOT       = config.PROJECT_ROOT;
const STATE_DIR  = config.STATE_DIR;

const DIRECTIVE_PATH = path.join(STATE_DIR, "curiosity_directive.txt");
const QUEUE_FILE     = path.join(STATE_DIR, "reading_queue.jsonl");
const STATE_FILE     = path.join(STATE_DIR, "search_curiosity_state.json");

const MAX_URLS = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

function appendQueue(entry) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

function hash(str) {
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 16);
}

// Extract the RESEARCH FOCUS line from curiosity_directive.txt
function extractFocus(directive) {
  const m = directive.match(/RESEARCH FOCUS:\s*"([^"]+)"/);
  if (m) return m[1].trim();
  // Fallback: first non-empty non-header line
  const lines = directive.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("──"));
  return lines[0] || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DIRECTIVE_PATH)) {
    console.log("[search_curiosity] no curiosity directive found — skipping");
    return;
  }

  const directive = fs.readFileSync(DIRECTIVE_PATH, "utf-8");
  const directiveHash = hash(directive);

  const state = loadJson(STATE_FILE) || {};
  if (state.last_directive_hash === directiveHash) {
    console.log("[search_curiosity] directive unchanged — skipping");
    return;
  }

  const focus = extractFocus(directive);
  if (!focus) {
    console.log("[search_curiosity] could not extract research focus — skipping");
    return;
  }

  console.log(`[search_curiosity] searching for: "${focus}"`);

  // Use Gemini with google_search tool — same pattern as verify_one.js
  const prompt = `You are a research assistant helping Sebastian D. Hunter, an autonomous AI agent
that forms beliefs through continuous observation. Sebastian is currently researching: "${focus}".

Find 3 high-quality, specific web pages (news articles, research papers, official reports, or
authoritative analyses) that would give Sebastian primary-source evidence about this topic.

Prioritise: news wire services, academic sources, official government sources, reputable
investigative journalism. Avoid: opinion blogs, social media, aggregators.

For each result, provide the direct URL to the specific article or document.

Respond in JSON:
{
  "urls": [
    { "url": "https://...", "title": "...", "why": "one sentence on why this is relevant" },
    { "url": "https://...", "title": "...", "why": "..." },
    { "url": "https://...", "title": "...", "why": "..." }
  ]
}`;

  let urls = [];
  try {
    const { project, location } = getProjectConfig();
    const apiKey = process.env.BUILDER_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!apiKey) throw new Error("no GCP credentials found");

    const token = await getTokenForKey(apiKey);
    const apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`;

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Extract grounding URLs first (most reliable)
    const grounding = data?.candidates?.[0]?.groundingMetadata;
    const groundingUrls = (grounding?.groundingChunks || [])
      .filter(c => c.web?.uri)
      .map(c => ({ url: c.web.uri, title: c.web.title || focus, why: "grounded search result" }))
      .slice(0, MAX_URLS);

    if (groundingUrls.length > 0) {
      urls = groundingUrls;
    } else {
      // Fall back to JSON in model text
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        urls = (parsed.urls || [])
          .filter(u => u.url && u.url.startsWith("http"))
          .slice(0, MAX_URLS);
      }
    }
  } catch (err) {
    console.error(`[search_curiosity] search failed: ${err.message}`);
  }

  if (urls.length === 0) {
    console.log("[search_curiosity] no URLs returned — skipping queue");
  } else {
    for (const u of urls) {
      appendQueue({
        url: u.url,
        source: "search_curiosity",
        title: u.title || focus,
        why: u.why || "",
        research_focus: focus,
        queued_at: new Date().toISOString(),
      });
      console.log(`[search_curiosity] queued: ${u.url}`);
    }
  }

  saveJson(STATE_FILE, {
    last_directive_hash: directiveHash,
    last_run: new Date().toISOString(),
    focus,
    urls_queued: urls.length,
  });

  console.log(`[search_curiosity] done — ${urls.length} URL(s) queued for "${focus}"`);
}

main().catch(err => {
  console.error(`[search_curiosity] error: ${err.message}`);
  process.exit(0); // non-fatal
});
