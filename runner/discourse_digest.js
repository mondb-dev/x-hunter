#!/usr/bin/env node
/**
 * runner/discourse_digest.js — format recent reply exchanges for agent prompts
 *
 * Reads the last N interactions from state/interactions.json and cross-references
 * state/discourse_anchors.jsonl to flag substantive counter-arguments.
 *
 * Writes state/discourse_digest.txt — injected into both browse and tweet agent
 * prompts so the agent can reference recent discourse in its journal and tweets.
 *
 * Usage: node runner/discourse_digest.js [--limit N]
 *   --limit N   how many recent exchanges to include (default: 5)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT         = path.resolve(__dirname, "..");
const INTERACTIONS = path.join(ROOT, "state", "interactions.json");
const ANCHORS      = path.join(ROOT, "state", "discourse_anchors.jsonl");
const OUT          = path.join(ROOT, "state", "discourse_digest.txt");

const args  = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) || 5 : 5;

// ── Load substantive anchor IDs ───────────────────────────────────────────────

function getSubstantiveIds() {
  if (!fs.existsSync(ANCHORS)) return new Map();
  const substantive = new Map(); // post_id → {summary, topic}
  try {
    const lines = fs.readFileSync(ANCHORS, "utf-8").split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.post_id && e.summary && !e.processed_at) {
          substantive.set(e.post_id, { summary: e.summary, topic: e.topic });
        }
      } catch { /* skip */ }
    }
  } catch { /* file unreadable */ }
  return substantive;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const stateDir = path.join(ROOT, "state");
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

if (!fs.existsSync(INTERACTIONS)) {
  fs.writeFileSync(OUT, "(no discourse yet — no reply exchanges logged)\n", "utf-8");
  console.log("[discourse_digest] no interactions yet");
  process.exit(0);
}

let interactions;
try {
  interactions = JSON.parse(fs.readFileSync(INTERACTIONS, "utf-8"));
} catch (e) {
  fs.writeFileSync(OUT, "(could not read interactions.json)\n", "utf-8");
  console.log(`[discourse_digest] parse error: ${e.message}`);
  process.exit(0);
}

const replies = (interactions.replies || []).slice(-LIMIT).reverse(); // most recent first

if (!replies.length) {
  fs.writeFileSync(OUT, "(no discourse yet — no reply exchanges logged)\n", "utf-8");
  console.log("[discourse_digest] no replies yet");
  process.exit(0);
}

const substantive = getSubstantiveIds();
const ts          = new Date().toISOString().replace("T", " ").slice(0, 16);
const HR          = "─".repeat(70);

const lines = [
  `── recent discourse · ${ts} ${HR.slice(ts.length + 21)}`,
  `${replies.length} exchange(s) — most recent first`,
  ``,
];

for (const r of replies) {
  const theirText  = (r.their_text || "").replace(/\n/g, " ").trim();
  const ourReply   = (r.our_reply  || "").replace(/\n/g, " ").trim();
  const when       = (r.replied_at || "").slice(0, 10);
  const anchor     = substantive.get(r.id);
  const flagLine   = anchor
    ? `  ★ SUBSTANTIVE CHALLENGE: ${anchor.summary}`
    : null;

  lines.push(`  @${r.from || "unknown"} [${when}]:`);
  lines.push(`  They: "${theirText.slice(0, 200)}"`);
  lines.push(`  You:  "${ourReply.slice(0, 200)}"`);
  if (flagLine) lines.push(flagLine);
  lines.push(``);
}

lines.push(`── end discourse ${HR.slice(18)}`);

fs.writeFileSync(OUT, lines.join("\n"), "utf-8");
console.log(`[discourse_digest] wrote ${replies.length} exchange(s) to discourse_digest.txt`);
process.exit(0);
