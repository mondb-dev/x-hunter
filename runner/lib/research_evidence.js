"use strict";
/**
 * runner/lib/research_evidence.js — turn a finished research pass into belief
 * evidence, so the findings are not wasted.
 *
 * Before this, deep research produced a report page and nothing else: the
 * ontology was fed only by the browse cycle, so a day spent reading primary
 * sources moved no axis. A research pass is the BEST evidence the system has —
 * primary sources, actually fetched, already assessed for confidence — and it
 * is the only evidence stream whose sources are not "whatever the feed showed".
 *
 * What it does NOT do: invent axes, or file anything it cannot ground. Every
 * entry must name an agenda axis, a URL the research actually retrieved, and a
 * finding the report supports. The entry records WHAT THE SOURCE SHOWS (which
 * pole it illustrates), not what Sebastian concludes — same contract as browse
 * evidence, and the reason score is "observed_pole_balance" at the boundary.
 *
 * Entries are written to state/ontology_delta_inbox/ rather than to
 * state/ontology_delta.json, because that single file is the browse agent's and
 * apply_ontology_delta.js deletes it after applying — a second writer would
 * clobber the first. apply_ontology_delta.js drains the inbox in the same pass
 * and records the writer on every entry.
 *
 * From there the normal guards apply: stance validation, trust weighting, the
 * diversity guard, claim/source dedup, and the per-day drift cap.
 *
 * RESEARCH_EVIDENCE=off disables filing. RESEARCH_EVIDENCE_MAX caps items/pass.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const INBOX = path.join(ROOT, "state", "ontology_delta_inbox");

const MAX_ITEMS = Math.max(1, parseInt(process.env.RESEARCH_EVIDENCE_MAX, 10) || 8);
const MAX_PER_AXIS = 2;
const MAX_CONTENT = 220;
const URL_RE = /https?:\/\/[^\s)<>"'\]]+/g;

function log(msg) { console.log(`[research_evidence] ${msg}`); }

function normUrl(u) {
  return String(u).trim().replace(/[).,;'"\]]+$/, "")
    .replace(/^http:/i, "https:").replace(/^https:\/\/www\./i, "https://").toLowerCase();
}

/**
 * URLs the research actually touched. Mirrors solution_brief.js groundingPool:
 * `read` = pages fetched by the research agent, `seen` = anything retrieved.
 */
function sourcePool(res = {}, extraText = "") {
  const read = new Set();
  const seen = new Set();
  for (const f of res.findings || []) {
    if (f.tool === "fetch" && /^https?:/i.test(String(f.input))) read.add(normUrl(f.input));
    const blob = `${f.input || ""} ${typeof f.result === "string" ? f.result : JSON.stringify(f.result || "")}`;
    for (const u of blob.match(URL_RE) || []) seen.add(normUrl(u));
  }
  for (const u of `${res.report || ""} ${extraText}`.match(URL_RE) || []) seen.add(normUrl(u));
  for (const u of read) seen.add(u);
  return { read, seen };
}

function axesPrompt(axes) {
  return axes.map((a) => `- ${a.id}\n    label: ${a.label}\n    left:  ${a.left_pole}\n    right: ${a.right_pole}`).join("\n");
}

function extractPrompt({ question, report, axes, allowed }) {
  return `You are recording BELIEF EVIDENCE from a finished research pass, for an ontology of belief axes.

RESEARCH QUESTION: ${question}

AXES (use these ids only):
${axesPrompt(axes)}

RETRIEVED SOURCES (copy a URL verbatim from this list — nothing else counts):
${allowed.slice(0, 40).join("\n")}

RESEARCH REPORT:
${String(report || "").slice(0, 9000)}

Return JSON only:
{"evidence":[{"axis_id":"...","pole_alignment":"left|right","content":"what this source shows, one line","source":"https://..."}]}

Rules:
- An entry records WHAT A SOURCE SHOWS, not what you or the researcher concludes. "METR measured X" is evidence; "this proves labs are reckless" is not.
- pole_alignment = which pole of that axis the finding illustrates.
- content: <= ${MAX_CONTENT} chars, specific — name the lab, paper, number, measurement or documented action. No adjectives standing in for facts.
- source: copied EXACTLY from RETRIEVED SOURCES. Never invent or reconstruct a URL.
- Only findings the report actually supports. Prefer distinct sources; at most ${MAX_PER_AXIS} entries per axis, ${MAX_ITEMS} total.
- If the research supports no axis evidence, return {"evidence":[]}. An empty answer is a fine answer.`;
}

/** Mechanical validation — the model's output is a proposal, not a verdict. */
function validate(items, { axes, pool }) {
  const byId = new Map(axes.map((a) => [a.id, a]));
  const perAxis = new Map();
  const seenPairs = new Set();
  const kept = [];
  const dropped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const axis_id = String((it || {}).axis_id || "").trim();
    const pole = String((it || {}).pole_alignment || "").trim().toLowerCase();
    const content = String((it || {}).content || "").trim().slice(0, MAX_CONTENT);
    const source = normUrl((it || {}).source || "");
    if (!byId.has(axis_id)) { dropped.push(`axis "${axis_id}" not on the agenda`); continue; }
    if (pole !== "left" && pole !== "right") { dropped.push(`bad pole "${pole}"`); continue; }
    if (content.length < 20) { dropped.push("content too thin"); continue; }
    if (!source || !pool.seen.has(source)) { dropped.push(`source not retrieved: ${source || "(none)"}`); continue; }
    const pair = `${axis_id}|${source}`;
    if (seenPairs.has(pair)) { dropped.push("duplicate axis+source"); continue; }
    const n = perAxis.get(axis_id) || 0;
    if (n >= MAX_PER_AXIS) { dropped.push(`> ${MAX_PER_AXIS} entries for ${axis_id}`); continue; }
    seenPairs.add(pair);
    perAxis.set(axis_id, n + 1);
    kept.push({ axis_id, pole_alignment: pole, content, source, read: pool.read.has(source) });
    if (kept.length >= MAX_ITEMS) break;
  }
  return { kept, dropped };
}

function writeInbox(evidence, meta) {
  fs.mkdirSync(INBOX, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const hash = crypto.createHash("sha1").update(meta.question || String(Math.random())).digest("hex").slice(0, 8);
  const file = path.join(INBOX, `${stamp}-${hash}.json`);
  fs.writeFileSync(file, JSON.stringify({
    writer: meta.writer || "deep_research",
    question: meta.question || null,
    track: meta.track || null,
    report_url: meta.url || null,
    created_at: new Date().toISOString(),
    evidence: evidence.map((e) => ({
      axis_id: e.axis_id,
      source: e.source,
      content: e.content,
      summary: meta.question ? `research: ${String(meta.question).slice(0, 120)}` : "",
      timestamp: new Date().toISOString(),
      pole_alignment: e.pole_alignment,
    })),
  }, null, 2), "utf-8");
  return file;
}

/**
 * File evidence from a completed research pass.
 * res: the deep_research result ({ report, findings }) — findings give the
 * retrieved-URL pool, so a report alone yields only URLs it cites verbatim.
 */
async function fileResearchEvidence(res, meta = {}) {
  if (String(process.env.RESEARCH_EVIDENCE || "").toLowerCase() === "off") return { filed: 0, skipped: "disabled" };
  const { getAgenda } = require("./research_agenda");
  const agenda = getAgenda();
  if (!agenda) return { filed: 0, skipped: "no agenda" };
  if (!res || !String(res.report || "").trim()) return { filed: 0, skipped: "no report" };

  const pool = sourcePool(res, meta.extraText || "");
  if (!pool.seen.size) return { filed: 0, skipped: "no retrieved sources" };

  // Prefer axes on this question's track, but allow the whole agenda: a policy
  // report often carries the cleanest evidence about lab commitments.
  const axes = [...agenda.axes].sort((a, b) =>
    (b.track === meta.track ? 1 : 0) - (a.track === meta.track ? 1 : 0));

  const allowed = [...pool.read, ...[...pool.seen].filter((u) => !pool.read.has(u))];
  let items = null;
  try {
    const { reason } = require("./compose");
    const raw = await reason(extractPrompt({ question: meta.question || "", report: res.report, axes, allowed }), {
      tag: "research_evidence", maxTokens: 1200,
    });
    const m = String(raw).replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    items = m ? (JSON.parse(m[0]).evidence || []) : null;
  } catch (e) {
    log(`extraction failed (non-fatal): ${e.message}`);
    return { filed: 0, skipped: "extraction failed" };
  }
  if (!items) return { filed: 0, skipped: "unparseable extraction" };

  const { kept, dropped } = validate(items, { axes, pool });
  if (!kept.length) {
    log(`nothing filed from "${String(meta.question || "").slice(0, 60)}"${dropped.length ? ` (${dropped.length} dropped: ${dropped.slice(0, 3).join("; ")})` : ""}`);
    return { filed: 0, skipped: "nothing valid" };
  }
  const file = writeInbox(kept, meta);
  log(`filed ${kept.length} evidence entr${kept.length === 1 ? "y" : "ies"} (${kept.filter((k) => k.read).length} from pages actually read${dropped.length ? `, ${dropped.length} dropped` : ""}) → ${path.basename(file)}`);
  // The same validated claims are the substance the writing layer speaks from
  // (lib/knowledge_base.js) — an axis says where to look, these say what he found.
  return {
    filed: kept.length,
    dropped: dropped.length,
    file,
    claims: kept.map((k) => ({ claim: k.content, source: k.source })),
  };
}

module.exports = { fileResearchEvidence, sourcePool, validate, INBOX };
