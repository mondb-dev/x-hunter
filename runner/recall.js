#!/usr/bin/env node
/**
 * runner/recall.js — memory recall CLI
 *
 * Searches the local SQLite memory index for past journals, checkpoints,
 * and belief reports relevant to a query, then writes a formatted summary
 * to state/memory_recall.txt for use by the tweet-synthesis agent in run.sh.
 *
 * Search strategy:
 *   1. Semantic — embed the query with nomic-embed-text, cosine-similarity over stored
 *      embeddings.  Falls back to FTS5 if embeddings unavailable.
 *   2. FTS5     — forced with --fts flag, or automatic fallback.
 *   3. Recent   — used when no --query supplied.
 *
 * Usage:
 *   node runner/recall.js --query "consciousness automation"
 *   node runner/recall.js --query "AI" --type journal --limit 5
 *   node runner/recall.js --query "X" --fts            (force FTS5)
 *   node runner/recall.js --limit 5                    (recent entries)
 *   node runner/recall.js --query "X" --print          (also print to stdout)
 *
 * Options:
 *   --query  <str>   Search terms (semantic or FTS5)
 *   --type   <str>   Filter by type: journal | checkpoint | belief_report
 *   --limit  <n>     Max results (default: 5)
 *   --fts            Force FTS5 instead of semantic search
 *   --print          Also print output to stdout
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { loadScraperDb, loadVerificationDb } = require("./lib/db_backend");
const db = loadScraperDb();
const vdb = loadVerificationDb();
const { embed, topK } = require("../scraper/embed");

const ROOT        = path.resolve(__dirname, "..");
const RECALL_FILE = path.join(ROOT, "state", "memory_recall.txt");

// ── CLI arg parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, defaultVal = null) {
  const i = args.indexOf(flag);
  if (i === -1) return defaultVal;
  return args[i + 1] ?? defaultVal;
}

const query    = getArg("--query");
const type     = getArg("--type");
const limit    = parseInt(getArg("--limit", "5"), 10);
const doPrint  = args.includes("--print");
const forceFts = args.includes("--fts");

// ── Format helpers ────────────────────────────────────────────────────────────

const HR = "─".repeat(70);

function formatEntry(row, similarity = null) {
  const typeLabel = row.type === "journal"        ? "journal"
                  : row.type === "checkpoint"     ? "checkpoint"
                  : row.type === "belief_report"  ? "belief report"
                  : row.type;

  const when = row.hour != null
    ? `${row.date} ${String(row.hour).padStart(2, "0")}:00`
    : row.date;

  const simLabel = similarity != null ? ` · sim=${similarity.toFixed(3)}` : "";
  const header   = `[${typeLabel} · ${row.title} · ${when}${simLabel}]`;

  const excerpt = (row.text_content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

  const tags    = row.keywords ? `Tags: ${row.keywords}` : null;
  const arweave = row.tx_id
    ? `Arweave: https://sebastianhunter.fun/arweave/${row.tx_id}`
    : "(not yet uploaded to Arweave)";

  return [header, `"${excerpt}..."`, tags, arweave].filter(Boolean).join("\n");
}

function formatVerification(row) {
  const statusMap = { supported: "SUPPORTED", refuted: "REFUTED", contested: "CONTESTED",
                      unverified: "UNVERIFIED", expired: "EXPIRED" };
  const status   = statusMap[row.status] ?? row.status.toUpperCase();
  const pct      = Math.round((row.confidence_score ?? 0) * 100);
  const when     = row.last_verified_at ?? row.created_at ?? "";
  const dateStr  = when ? new Date(when).toISOString().slice(0, 10) : "";
  const source   = row.source_handle ? `@${row.source_handle}` : (row.claim_source ?? "");
  const header   = `[verification · ${status} · ${pct}% confidence · ${dateStr}${source ? " · " + source : ""}]`;
  const claim    = `Claim: "${(row.claim_text || "").trim()}"`;
  const summary  = row.web_search_summary
    ? `Finding: ${row.web_search_summary.trim().slice(0, 200)}`
    : null;
  const link     = `https://sebastianhunter.fun/veritas-lens#${row.claim_id}`;
  return [header, claim, summary, link].filter(Boolean).join("\n");
}

// ── Semantic search over memory embeddings ────────────────────────────────────

async function semanticRecall(queryText, typeFilter, limitN) {
  const queryVec = await embed(queryText);
  if (!queryVec) return null; // fall back to FTS5

  const embeddings = await db.allEmbeddings("memory");
  if (embeddings.length === 0) return null; // nothing embedded yet

  const nearest = topK(queryVec, embeddings, limitN * 3); // over-fetch, filter after

  const results = [];
  for (const hit of nearest) {
    const { rows: memRows } = await db.raw().query("SELECT * FROM memory WHERE id = $1", [parseInt(hit.entity_id, 10)]);
    const row = memRows[0];
    if (!row) continue;
    if (typeFilter && row.type !== typeFilter) continue;
    results.push({ ...row, _similarity: hit.similarity });
    if (results.length >= limitN) break;
  }

  return results; // may be empty array — caller checks length
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  let results = [];
  let queryLabel;
  let usedSemantic = false;

  if (query) {
    queryLabel = `"${query}"`;

    if (!forceFts) {
      const semResults = await semanticRecall(query, type || null, limit);
      // Accept semantic results only if at least one hit has meaningful similarity.
      // Proper nouns / handles score near-zero — fall through to FTS5 in that case.
      const SEM_MIN_SCORE = 0.05;
      const bestScore = semResults?.length ? semResults[0]._similarity ?? 0 : 0;
      if (semResults !== null && semResults.length > 0 && bestScore >= SEM_MIN_SCORE) {
        results      = semResults;
        usedSemantic = true;
        if (type) queryLabel += ` [type:${type}]`;
        queryLabel += " [semantic]";
      }
    }

    if (!usedSemantic) {
      // FTS5 fallback (or forced)
      results    = await db.recallMemory(query, limit);
      queryLabel += " [fts5]";
      if (type) {
        results    = results.filter(r => r.type === type);
        queryLabel += ` [type:${type}]`;
      }
    }
  } else {
    results    = await db.recentMemory(type || null, limit);
    queryLabel = type ? `recent ${type} entries` : "recent entries";
  }

  const lines = [];
  lines.push(`── memory recall: ${queryLabel} ${HR.slice(queryLabel.length + 20)}`);
  lines.push("");

  if (results.length === 0) {
    lines.push("(no matching memory entries found)");
  } else {
    for (const row of results) {
      const sim = usedSemantic && row._similarity != null ? row._similarity : null;
      lines.push(formatEntry(row, sim));
      lines.push("");
    }
  }

  // ── Verification recall ─────────────────────────────────────────────────
  if (query) {
    let vResults = [];
    try {
      vResults = await vdb.recallVerifications(query, 3);
    } catch { /* verification db unavailable — skip */ }

    if (vResults.length > 0) {
      lines.push(`── veritas lens: matching verified claims ──────────────────────────────`);
      lines.push("");
      for (const row of vResults) {
        lines.push(formatVerification(row));
        lines.push("");
      }
    }
  }

  lines.push(`── end recall (${results.length} result${results.length === 1 ? "" : "s"}) ${HR.slice(25)}`);

  const output = lines.join("\n");

  const stateDir = path.join(ROOT, "state");
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(RECALL_FILE, output, "utf-8");

  if (doPrint) {
    process.stdout.write(output + "\n");
  } else {
    const method = usedSemantic ? "semantic" : "fts5";
    console.log(`[recall] wrote ${results.length} result(s) to state/memory_recall.txt (${method})`);
  }

  process.exit(0);
})();
