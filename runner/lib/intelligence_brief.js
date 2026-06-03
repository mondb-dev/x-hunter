"use strict";
/**
 * runner/lib/intelligence_brief.js — topic-aware intelligence context assembler
 *
 * Assembles a structured intelligence package for a given topic query:
 *   1. Topic-matched belief axes (from ontology.json)
 *   2. Recent CUSUM drift alerts on matched axes (from drift_alerts.jsonl)
 *   3. Verified/refuted claims matching topic (from verification_export.json)
 *   4. Memory recall excerpts (via recall.js subprocess)
 *   5. Recent browse_notes entries matching topic
 *
 * Used by:
 *   - scraper/reply.js      — enriches X reply context
 *   - runner/telegram_bot.js — powers /brief command
 *
 * Usage:
 *   const { gatherBrief, formatBriefForPrompt, formatBriefForHuman } = require('./intelligence_brief');
 *   const brief = gatherBrief('immigration policy Philippines');
 *   const promptBlock = formatBriefForPrompt(brief);  // inject into LLM prompt
 *   const humanText  = formatBriefForHuman(brief);    // send to operator on TG
 */

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");
const config        = require("./config");

const ROOT                 = config.PROJECT_ROOT;
const STATE                = config.STATE_DIR;
const ONTOLOGY_PATH        = config.ONTOLOGY_PATH;
const DRIFT_ALERTS_PATH    = path.join(STATE, "drift_alerts.jsonl");
const VERIFICATION_PATH    = path.join(STATE, "verification_export.json");
const BROWSE_NOTES_PATH    = path.join(STATE, "browse_notes.md");
const RECALL_SCRIPT        = path.join(ROOT, "runner", "recall.js");

const MAX_AXES      = 5;   // topic-matched axes to include
const MAX_DRIFT     = 3;   // recent drift alerts to include
const MAX_CLAIMS    = 5;   // verified/refuted claims to include
const MAX_MEMORY    = 3;   // memory recall excerpts to include
const DRIFT_WINDOW  = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

function loadJsonl(p) {
  try {
    return fs.readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Tokenise a string into lowercase words for matching.
 */
function tokenise(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * Simple keyword overlap score between two strings.
 * Returns 0–1 (fraction of query tokens found in target).
 */
function overlapScore(queryTokens, target) {
  if (!queryTokens.length) return 0;
  const targetTokens = new Set(tokenise(target));
  const hits = queryTokens.filter(t => t.length > 3 && targetTokens.has(t)).length;
  return hits / queryTokens.length;
}

// ── 1. Topic-matched axes ─────────────────────────────────────────────────────

function matchAxes(queryTokens) {
  const onto = loadJson(ONTOLOGY_PATH, { axes: [] });
  const axes = Array.isArray(onto.axes) ? onto.axes : Object.values(onto.axes || {});

  return axes
    .map(ax => {
      const searchText = [
        ax.label || ax.name || ax.id || "",
        ax.description || "",
        ax.left_pole || "",
        ax.right_pole || "",
        ax.current_stance || "",
      ].join(" ");
      return { ax, score: overlapScore(queryTokens, searchText) };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.ax.confidence || 0) - (a.ax.confidence || 0))
    .slice(0, MAX_AXES)
    .map(r => {
      const ax = r.ax;
      return {
        id:         ax.id,
        label:      ax.label || ax.name || ax.id,
        confidence: ax.confidence || 0,
        score:      ax.score || 0,
        stance:     ax.current_stance || null,
        evidence:   (ax.evidence_log || []).length,
        match:      r.score,
      };
    });
}

// ── 2. Recent drift alerts on matched axes ────────────────────────────────────

function matchDrift(matchedAxisIds) {
  if (!matchedAxisIds.length) return [];
  const idSet  = new Set(matchedAxisIds);
  const cutoff = Date.now() - DRIFT_WINDOW;
  const alerts = loadJsonl(DRIFT_ALERTS_PATH);

  return alerts
    .filter(a => idSet.has(a.axis_id) && new Date(a.ts).getTime() > cutoff)
    .slice(-MAX_DRIFT)
    .map(a => ({
      axis_label: a.axis_label,
      direction:  a.direction,
      ts:         a.ts,
      cusum:      a.cusum_value,
      score:      a.current_score,
    }));
}

// ── 3. Verified / refuted claims on topic ─────────────────────────────────────

function matchClaims(queryTokens) {
  const data = loadJson(VERIFICATION_PATH, []);
  const claims = Array.isArray(data) ? data : (data.claims || []);

  return claims
    .filter(c => c.status === "supported" || c.status === "refuted" || c.status === "contested")
    .map(c => ({
      c,
      score: overlapScore(queryTokens, (c.claim_text || "") + " " + (c.summary || "")),
    }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CLAIMS)
    .map(r => ({
      claim:      r.c.claim_text,
      status:     r.c.status,
      confidence: r.c.confidence_score || r.c.display_score || 0,
      summary:    r.c.summary || null,
      lens_url:   r.c.lens_url || null,
    }));
}

// ── 4. Memory recall (via recall.js subprocess) ───────────────────────────────

function recallMemory(query) {
  try {
    const safeQuery = query.replace(/"/g, "'").slice(0, 200);
    const result = execSync(
      `node "${RECALL_SCRIPT}" --query "${safeQuery}" --limit ${MAX_MEMORY} --print`,
      { cwd: ROOT, timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return (result || "").slice(0, 3000).trim();
  } catch {
    try { return (fs.readFileSync(config.MEMORY_RECALL_PATH, "utf-8") || "").slice(0, 3000).trim(); }
    catch { return ""; }
  }
}

// ── 5. Recent browse_notes entries on topic ───────────────────────────────────

function matchBrowseNotes(queryTokens) {
  try {
    const lines = fs.readFileSync(BROWSE_NOTES_PATH, "utf-8")
      .split("\n")
      .filter(l => l.trim() && !l.startsWith("#"));

    return lines
      .filter(l => overlapScore(queryTokens, l) > 0)
      .slice(-10)  // most recent matches
      .join("\n")
      .slice(0, 1500)
      .trim();
  } catch { return ""; }
}

// ── Main: assemble brief ──────────────────────────────────────────────────────

/**
 * Gather a topic-aware intelligence brief.
 * @param {string} topic  - free-text query (mention text, /brief argument, etc.)
 * @returns {object}      - structured brief
 */
function gatherBrief(topic) {
  const queryTokens = tokenise(topic);

  const axes   = matchAxes(queryTokens);
  const drift  = matchDrift(axes.map(a => a.id));
  const claims = matchClaims(queryTokens);
  const memory = recallMemory(topic);
  const notes  = matchBrowseNotes(queryTokens);

  return { topic, queryTokens, axes, drift, claims, memory, notes };
}

// ── Formatters ────────────────────────────────────────────────────────────────

/**
 * Format brief as a block to inject into an LLM prompt.
 */
function formatBriefForPrompt(brief) {
  const parts = [];

  if (brief.axes.length) {
    const lines = brief.axes.map(ax => {
      const dir  = ax.score > 0.1 ? "→" : ax.score < -0.1 ? "←" : "·";
      const conf = (ax.confidence * 100).toFixed(0);
      const stance = ax.stance ? ` — "${ax.stance}"` : "";
      return `  ${dir} ${ax.label} (${conf}% confidence, ${ax.evidence} evidence entries)${stance}`;
    });
    parts.push(`RELEVANT BELIEF AXES for this topic:\n${lines.join("\n")}`);
  }

  if (brief.drift.length) {
    const lines = brief.drift.map(d => {
      const ago = Math.round((Date.now() - new Date(d.ts).getTime()) / 3_600_000);
      return `  [${ago}h ago] ${d.axis_label} — shifted ${d.direction} (CUSUM ${d.cusum}, score now ${d.score?.toFixed(3)})`;
    });
    parts.push(`RECENT DRIFT SIGNALS (last 7 days):\n${lines.join("\n")}`);
  }

  if (brief.claims.length) {
    const lines = brief.claims.map(c => {
      const conf = (c.confidence * 100).toFixed(0);
      const link = c.lens_url ? ` → ${c.lens_url}` : "";
      return `  [${c.status.toUpperCase()} ${conf}%] "${c.claim.slice(0, 120)}"${c.summary ? `\n    ${c.summary.slice(0, 150)}` : ""}${link}`;
    });
    parts.push(`VERIFIED CLAIMS on this topic:\n${lines.join("\n")}`);
  }

  if (brief.memory) {
    parts.push(`PAST OBSERVATIONS on this topic (from journals/checkpoints):\n${brief.memory}`);
  }

  if (brief.notes) {
    parts.push(`RECENT BROWSE NOTES on this topic:\n${brief.notes}`);
  }

  return parts.length
    ? `\n## Intelligence brief: "${brief.topic}"\n${parts.join("\n\n")}\n`
    : "";
}

/**
 * Format brief for human reading (Telegram operator message).
 */
function formatBriefForHuman(brief) {
  const lines = [];

  lines.push(`*Intelligence brief: ${brief.topic}*`);
  lines.push("");

  if (brief.axes.length) {
    lines.push("*Relevant axes:*");
    for (const ax of brief.axes) {
      const dir  = ax.score > 0.1 ? "↑" : ax.score < -0.1 ? "↓" : "·";
      const conf = (ax.confidence * 100).toFixed(0);
      lines.push(`${dir} ${ax.label} — ${conf}% conf, score ${ax.score?.toFixed(3)}, ${ax.evidence} entries`);
      if (ax.stance) lines.push(`  _"${ax.stance}"_`);
    }
    lines.push("");
  }

  if (brief.drift.length) {
    lines.push("*Recent drift signals:*");
    for (const d of brief.drift) {
      const ago = Math.round((Date.now() - new Date(d.ts).getTime()) / 3_600_000);
      lines.push(`⚡ ${d.axis_label} shifted ${d.direction} (${ago}h ago)`);
    }
    lines.push("");
  }

  if (brief.claims.length) {
    lines.push("*Verified claims:*");
    for (const c of brief.claims) {
      const icon = c.status === "supported" ? "✅" : c.status === "refuted" ? "❌" : "⚠️";
      lines.push(`${icon} ${c.status.toUpperCase()} — "${c.claim.slice(0, 100)}"`);
      if (c.summary) lines.push(`  ${c.summary.slice(0, 120)}`);
      if (c.lens_url) lines.push(`  ${c.lens_url}`);
    }
    lines.push("");
  }

  if (brief.memory) {
    lines.push("*Past observations:*");
    lines.push(brief.memory.slice(0, 800));
    lines.push("");
  }

  if (!brief.axes.length && !brief.claims.length && !brief.memory) {
    lines.push("No specific findings indexed for this topic yet.");
    lines.push("Try a broader term, or check back after more observation cycles.");
  }

  return lines.join("\n");
}

module.exports = { gatherBrief, formatBriefForPrompt, formatBriefForHuman };
