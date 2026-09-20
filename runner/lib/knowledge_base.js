"use strict";
/**
 * runner/lib/knowledge_base.js — what Sebastian actually knows, as opposed to
 * what his feed happened to contain.
 *
 * THE DIVISION OF LABOUR (operator decision, 2026-09-19):
 *
 *   axes            anchors for research and observation — WHERE to look, and
 *                   where an observation gets filed. Not positions. An axis
 *                   score is the balance of what was read (which is why the
 *                   public export calls it observed_pole_balance).
 *   knowledge base  the substance — findings from his own research, each with
 *                   the source it came from, and the solution briefs that
 *                   survived the gate. This is what he SAYS and what he PLANS
 *                   from.
 *
 * Before this, the writing layer derived "I strongly hold that X" from an axis
 * score, i.e. from feed composition. A finding here carries a claim, its source
 * URL and the report it came from, so a post can be checked by whoever reads it.
 *
 * Store: state/knowledge/findings.jsonl (append-only, newest last). Written by
 * plan_research.js (every research pass) and solution_brief.js (every brief,
 * including withheld ones — a failed gate is knowledge too).
 *
 * Retrieval is keyword scoring over claim + question + track, with a recency
 * tiebreak. No embeddings: embed() has returned null since 2026-07-30, and a
 * corpus this size does not need them.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, "state", "knowledge");
const FINDINGS = path.join(DIR, "findings.jsonl");

const STOP = new Set(("the a an and or of to in for on with by from at as is are was were be been it its this that these those what which who whom how why when where does do did will would should could can may might must not no if then than so such about into over under between across per via" ).split(" "));

function log(msg) { console.log(`[knowledge] ${msg}`); }

function tokens(s) {
  return String(s || "").toLowerCase().match(/[a-z0-9][a-z0-9+.-]{2,}/g) || [];
}

function readAll() {
  try {
    return fs.readFileSync(FINDINGS, "utf-8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function append(entry) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(FINDINGS, JSON.stringify(entry) + "\n", "utf-8");
  return entry;
}

function idFor(kind, key) {
  return `${kind}_${crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 10)}`;
}

/** A research pass: its headline finding, plus the cited claims it grounded. */
function recordReport({ question, track, keyFinding, confidence, url, claims = [], gated = false }) {
  const claim = String(keyFinding || "").trim();
  const cited = (claims || []).filter((c) => c && c.claim && c.source).slice(0, 8);
  if (!claim && !cited.length) return null;
  const entry = {
    id: idFor("rep", question || claim),
    ts: new Date().toISOString(),
    kind: "report",
    track: track || null,
    question: question || null,
    claim: claim || cited[0].claim,
    claims: cited.map((c) => ({ claim: String(c.claim).slice(0, 240), source: c.source })),
    sources: [...new Set(cited.map((c) => c.source))].slice(0, 8),
    url: url || null,
    confidence_pct: Number.isFinite(confidence) ? confidence : null,
    published: !gated && !!url,
  };
  append(entry);
  log(`recorded report: "${entry.claim.slice(0, 70)}" (${entry.claims.length} cited claim(s))`);
  return entry;
}

/** A solution brief — published or withheld. Both are knowledge. */
function recordBrief({ question, track, title, oneLine, test, status, url, reason, confidence }) {
  const entry = {
    id: idFor("brief", url || title || question),
    ts: new Date().toISOString(),
    kind: "brief",
    track: track || null,
    question: question || null,
    claim: String(oneLine || title || "").trim(),
    title: title || null,
    test: test || null,
    status: status || "proposed",
    reason: reason || null,
    url: url || null,
    confidence_pct: Number.isFinite(confidence) ? confidence : null,
    published: status === "proposed" && !!url,
  };
  if (!entry.claim && !entry.reason) return null;
  append(entry);
  log(`recorded brief (${entry.status}): "${String(entry.claim || entry.reason).slice(0, 70)}"`);
  return entry;
}

/** A pre-registered experiment that ran. First-party, and it could have failed. */
function recordExperiment({ id, question, track, hypothesis, metric, verdict, metric_value, summary, url, n, preregistered_at }) {
  const entry = {
    id: `exp_${String(id).replace(/^exp_/, "")}`,
    ts: new Date().toISOString(),
    kind: "experiment",
    track: track || null,
    question: question || null,
    claim: `${verdict === "supported" ? "Tested and supported" : verdict === "not_supported" ? "Tested and NOT supported" : "Tested, inconclusive"}: ${hypothesis || question}`,
    hypothesis: hypothesis || null,
    metric: metric || null,
    metric_value: metric_value === undefined ? null : metric_value,
    verdict,
    n: n || null,
    summary: String(summary || "").slice(0, 600),
    preregistered_at: preregistered_at || null,
    url: url || null,
    published: !!url,
  };
  append(entry);
  log(`recorded experiment (${verdict}): "${String(question || "").slice(0, 70)}"`);
  return entry;
}

function score(entry, qTokens) {
  if (!qTokens.length) return 0;
  const hay = new Set(tokens(`${entry.claim} ${entry.question} ${entry.title || ""} ${entry.hypothesis || ""} ${entry.track || ""} ${(entry.claims || []).map((c) => c.claim).join(" ")}`));
  let hits = 0;
  for (const t of qTokens) if (hay.has(t)) hits++;
  return hits / qTokens.length;
}

/** Findings most relevant to `topic`; falls back to the most recent. */
function search(topic, { limit = 8, kind = null, publishedOnly = false } = {}) {
  let rows = readAll();
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (publishedOnly) rows = rows.filter((r) => r.published);
  if (!rows.length) return [];
  const qTokens = tokens(topic).filter((t) => !STOP.has(t));
  if (!qTokens.length) return rows.slice(-limit).reverse();
  return rows
    .map((r, i) => ({ r, s: score(r, qTokens), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => (b.s - a.s) || (b.i - a.i))
    .slice(0, limit)
    .map((x) => x.r);
}

function recent(n = 8) { return readAll().slice(-n).reverse(); }

function stats() {
  const rows = readAll();
  const briefs = rows.filter((r) => r.kind === "brief");
  return {
    total: rows.length,
    experiments: rows.filter((r) => r.kind === "experiment").length,
    experiments_supported: rows.filter((r) => r.kind === "experiment" && r.verdict === "supported").length,
    experiments_not_supported: rows.filter((r) => r.kind === "experiment" && r.verdict === "not_supported").length,
    reports: rows.filter((r) => r.kind === "report").length,
    published_reports: rows.filter((r) => r.kind === "report" && r.published).length,
    briefs: briefs.length,
    published_briefs: briefs.filter((r) => r.published).length,
    withheld_briefs: briefs.filter((r) => r.status && r.status !== "proposed").length,
    cited_claims: rows.reduce((n, r) => n + ((r.claims || []).length), 0),
    tracks: [...new Set(rows.map((r) => r.track).filter(Boolean))],
  };
}

function line(r) {
  const when = String(r.ts || "").slice(0, 10);
  if (r.kind === "experiment") {
    // Pre-registered and run: the only kind of claim here that was ever at risk.
    return `- ${r.claim}${r.metric_value != null ? ` — ${r.metric}: ${JSON.stringify(r.metric_value)}` : ""}${r.n ? ` (n=${r.n}` : ""}${r.n ? `, pre-registered ${String(r.preregistered_at || "").slice(0, 10)})` : ""}` +
      `${r.summary ? `\n    ${r.summary}` : ""}${r.url ? `\n    ${r.url}` : ""}  [${when}]`;
  }
  if (r.kind === "brief") {
    const head = r.status === "proposed"
      ? `PROPOSAL: ${r.claim}`
      : `WITHHELD (${r.status}${r.reason ? `: ${String(r.reason).slice(0, 90)}` : ""}): ${r.claim || r.title || ""}`;
    return `- ${head}${r.test ? `\n    test: ${String(r.test).slice(0, 160)}` : ""}${r.url ? `\n    ${r.url}` : ""}  [${when}]`;
  }
  const cites = (r.claims || []).slice(0, 2).map((c) => `\n    · ${c.claim} — ${c.source}`).join("");
  return `- ${r.claim}${r.confidence_pct != null ? ` (research confidence ${r.confidence_pct}%)` : ""}${cites}${r.url ? `\n    ${r.url}` : ""}  [${when}]`;
}

/**
 * The block the writing and planning layers actually read.
 * purpose "voice"    — what he may say, and the sources that back it
 * purpose "planning" — what is already known, so a plan builds on it
 */
function knowledgeBlock({ topic = "", limit = 8, purpose = "voice" } = {}) {
  const rows = topic ? search(topic, { limit }) : recent(limit);
  if (!rows.length) {
    return purpose === "planning"
      ? "── WHAT YOU ALREADY KNOW ──\n(nothing recorded yet — the research has not produced findings, so plan research, not publication)"
      : "── WHAT YOU KNOW (your own research — this is your substance) ──\n(nothing recorded yet. You have no findings to speak from: ask questions, do not assert.)";
  }
  const head = purpose === "planning"
    ? "── WHAT YOU ALREADY KNOW (your own research — do not re-plan what is already answered; build on it) ──"
    : "── WHAT YOU KNOW (your own research — speak from THIS, and cite the source; an axis is a research direction, not a position) ──";
  return [head, ...rows.map(line)].join("\n");
}

module.exports = {
  recordReport, recordBrief, recordExperiment, search, recent, stats, knowledgeBlock, readAll,
  FINDINGS,
};
