#!/usr/bin/env node
/**
 * scraper/query.js — query the SQLite index, output a topic summary
 *
 * Used by runner/run.sh before each browse cycle to generate
 * state/topic_summary.txt — a compact, AI-readable digest of what
 * the scraper has indexed over the last N hours.
 *
 * Output written to state/topic_summary.txt.
 *
 * Also supports interactive queries via CLI flags:
 *   node query.js --search "AI automation"
 *   node query.js --keyword "attention economy"
 *   node query.js --hours 2
 */

"use strict";

const db   = require("./db");
const fs   = require("fs");
const path = require("path");

const ROOT    = path.resolve(__dirname, "..");
const OUT     = path.join(ROOT, "state", "topic_summary.txt");

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag = (f) => args.includes(f);

const hoursArg   = parseInt(flag("--hours") || "4", 10);
const searchArg  = flag("--search");
const keywordArg = flag("--keyword");

// ── Interactive modes ─────────────────────────────────────────────────────────
if (searchArg) {
  const results = db.search(searchArg, 10);
  console.log(`\nFTS5 results for "${searchArg}":\n`);
  for (const r of results) {
    console.log(`@${r.username} [score:${r.score?.toFixed(1)}] "${r.text.slice(0, 120)}"`);
    if (r.keywords) console.log(`  keywords: ${r.keywords}`);
  }
  process.exit(0);
}

if (keywordArg) {
  const results = db.postsByKeyword(keywordArg, 10);
  console.log(`\nPosts tagged "${keywordArg}":\n`);
  for (const r of results) {
    console.log(`@${r.username} [v${r.velocity?.toFixed(1)} T${r.trust}] "${r.text.slice(0, 120)}"`);
  }
  process.exit(0);
}

// ── Summary mode (default) ────────────────────────────────────────────────────
const hours = hoursArg;

// Prune old data
db.prune();

// Top keywords in the window
const keywords = db.topKeywords(hours, 20);

// Recent top posts
const posts = db.recentPosts(hours, 10);

// Build summary text
const now = new Date().toISOString().slice(0, 16).replace("T", " ");
const lines = [
  `── topic summary (last ${hours}h) — ${now} ──────────────────────────`,
  "",
];

if (keywords.length === 0) {
  lines.push("  No data indexed yet — scraper hasn't run or no posts collected.");
} else {
  // Topic clusters: group keywords by co-occurrence (simple: just list top ones)
  lines.push("TOP TOPICS (by post frequency):");
  for (const kw of keywords.slice(0, 15)) {
    const bar = "█".repeat(Math.min(kw.count, 10));
    lines.push(`  ${bar.padEnd(10)} ${kw.count}x  ${kw.keyword}`);
  }

  lines.push("");
  lines.push("TOP POSTS (by score, last " + hours + "h):");
  for (const p of posts) {
    const likes  = p.likes  >= 1000 ? `${(p.likes/1000).toFixed(1)}k❤`  : `${p.likes}❤`;
    const rts    = p.rts    >= 1000 ? `${(p.rts/1000).toFixed(1)}k🔁`   : `${p.rts}🔁`;
    lines.push(`  @${p.username} [v${p.velocity?.toFixed(1)} T${p.trust}] "${p.text.slice(0, 140)}" [${likes} ${rts}]`);
    if (p.keywords) lines.push(`    → ${p.keywords}`);
  }

  // Keyword clusters: pick top 5, show related posts for each
  lines.push("");
  lines.push("KEYWORD DEEP-DIVES (top 5 topics):");
  for (const kw of keywords.slice(0, 5)) {
    const related = db.postsByKeyword(kw.keyword, 3);
    lines.push(`\n  [${kw.keyword}] — ${kw.count} posts`);
    for (const r of related) {
      lines.push(`    @${r.username}: "${r.text.slice(0, 100)}"`);
    }
  }
}

lines.push("");
lines.push(`── end summary ─────────────────────────────────────────────────`);

const output = lines.join("\n");

// Write to file
fs.writeFileSync(OUT, output);

// Also print to stdout (for run.sh to optionally capture)
console.log(output);

process.exit(0);
