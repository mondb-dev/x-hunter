#!/usr/bin/env node
/**
 * runner/recall.js — memory recall CLI
 *
 * Searches the local SQLite memory index (FTS5) for past journals,
 * checkpoints, and belief reports relevant to a query, then writes
 * a formatted summary to state/memory_recall.txt for use by the
 * tweet-synthesis agent in run.sh.
 *
 * Usage:
 *   node runner/recall.js --query "consciousness automation"
 *   node runner/recall.js --query "AI" --type journal --limit 5
 *   node runner/recall.js --limit 5            (recent entries, no query)
 *   node runner/recall.js --query "X" --print  (also print to stdout)
 *
 * Options:
 *   --query  <str>   FTS5 search terms (default: recent entries)
 *   --type   <str>   Filter by type: journal | checkpoint | belief_report
 *   --limit  <n>     Max results (default: 5)
 *   --print          Also print output to stdout
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("../scraper/db");

const ROOT        = path.resolve(__dirname, "..");
const RECALL_FILE = path.join(ROOT, "state", "memory_recall.txt");

// ── CLI arg parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, defaultVal = null) {
  const i = args.indexOf(flag);
  if (i === -1) return defaultVal;
  return args[i + 1] ?? defaultVal;
}

const query  = getArg("--query");
const type   = getArg("--type");
const limit  = parseInt(getArg("--limit", "5"), 10);
const doPrint = args.includes("--print");

// ── Format helpers ────────────────────────────────────────────────────────────

const HR = "─".repeat(70);

function formatEntry(row) {
  const typeLabel = row.type === "journal"        ? "journal"
                  : row.type === "checkpoint"     ? "checkpoint"
                  : row.type === "belief_report"  ? "belief report"
                  : row.type;

  const when = row.hour != null
    ? `${row.date} ${String(row.hour).padStart(2, "0")}:00`
    : row.date;

  const header = `[${typeLabel} · ${row.title} · ${when}]`;

  const excerpt = (row.text_content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

  const tags = row.keywords
    ? `Tags: ${row.keywords}`
    : null;

  const arweave = row.tx_id
    ? `Arweave: https://arweave.net/${row.tx_id}`
    : "(not yet uploaded to Arweave)";

  return [header, `"${excerpt}..."`, tags, arweave]
    .filter(Boolean)
    .join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  let results;
  let queryLabel;

  if (query) {
    results    = db.recallMemory(query, limit);
    queryLabel = `"${query}"`;
    if (type) {
      results    = results.filter(r => r.type === type);
      queryLabel += ` [type:${type}]`;
    }
  } else {
    results    = db.recentMemory(type || null, limit);
    queryLabel = type ? `recent ${type} entries` : "recent entries";
  }

  const lines = [];

  lines.push(`── memory recall: ${queryLabel} ${HR.slice(queryLabel.length + 20)}`);
  lines.push("");

  if (results.length === 0) {
    lines.push("(no matching memory entries found)");
  } else {
    for (const row of results) {
      lines.push(formatEntry(row));
      lines.push("");
    }
  }

  lines.push(`── end recall (${results.length} result${results.length === 1 ? "" : "s"}) ${HR.slice(25)}`);

  const output = lines.join("\n");

  // Ensure state/ dir exists
  const stateDir = path.join(ROOT, "state");
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(RECALL_FILE, output, "utf-8");

  if (doPrint) {
    process.stdout.write(output + "\n");
  } else {
    console.log(`[recall] wrote ${results.length} result(s) to state/memory_recall.txt`);
  }

  process.exit(0);
})();
