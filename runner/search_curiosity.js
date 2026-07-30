#!/usr/bin/env node
/**
 * runner/search_curiosity.js — web-search expansion for curiosity directives
 *
 * Reads the current curiosity_directive.txt, extracts the RESEARCH FOCUS topic,
 * runs a browser web search and has Claude pick the best results, adding the top
 * 3 result URLs to
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

  // Claude has no search grounding, so the SEARCH is the browser (HelmStack
  // session, CDP scraper as fallback) and Claude only ranks/annotates what the
  // search actually returned. URLs therefore always come from real results —
  // the model never invents one, which was the failure mode of the old grounded
  // Gemini path when grounding came back empty.
  let urls = [];
  try {
    const { searchWeb } = require("./lib/helmstack_fetch");
    const { browserSearch } = require("./lib/browser_search");

    let results = await searchWeb(focus, { max: 10 }).catch(() => []);
    if (!results.length) results = await browserSearch(focus, { maxResults: 10 }).catch(() => []);
    if (!results.length) throw new Error("no search results");

    const candidates = results
      .filter(r => r.url && /^https?:/.test(r.url))
      .slice(0, 10)
      .map((r, i) => `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}\n   ${r.snippet || ""}`)
      .join("\n");

    const prompt = `Sebastian D. Hunter, an autonomous agent that forms beliefs through continuous
observation, is researching: "${focus}".

Below are real web search results. Pick the ${MAX_URLS} that would give him the best
primary-source evidence on this topic.

Prioritise: news wire services, academic sources, official government sources, reputable
investigative journalism. Avoid: opinion blogs, social media, aggregators.

SEARCH RESULTS:
${candidates}

Return ONLY the chosen entries, copying each URL EXACTLY as given above. Never invent a URL.`;

    const { composeJSON } = require("./lib/compose");
    const picked = await composeJSON(prompt, {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: {
            type: "object",
            properties: { url: { type: "string" }, title: { type: "string" }, why: { type: "string" } },
            required: ["url", "why"],
          },
        },
      },
      required: ["urls"],
    }, { tag: "search_curiosity" });

    // Hard guard: only accept URLs that appeared in the real search results.
    const allowed = new Set(results.map(r => r.url));
    urls = (picked.urls || [])
      .filter(u => u.url && allowed.has(u.url))
      .slice(0, MAX_URLS);

    if (!urls.length && results.length) {
      console.log("[search_curiosity] model returned no valid URL — falling back to top results");
      urls = results.slice(0, MAX_URLS).map(r => ({ url: r.url, title: r.title || focus, why: "top search result" }));
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
