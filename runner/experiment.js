#!/usr/bin/env node
"use strict";
/**
 * runner/experiment.js — run a pre-registered experiment.
 *
 * The register (lib/experiments.js) says what will be measured and what would
 * count as failure. This executes it and records the result against that
 * registration, whichever way it comes out.
 *
 * It runs DECLARATIVE specs — a fixed interpreter, not arbitrary code. That is
 * deliberate: the planning layer may propose experiments, and a plan must never
 * be able to talk the runtime into executing something it wrote.
 *
 *   self_log      compute: calibration | source_concentration | field_counts
 *                 over his own files (prediction log, ontology, posts, cost
 *                 ledger, knowledge base). No network, no model calls.
 *   llm_trial     items x conditions through the model; scored by regex or by a
 *                 judge restricted to a fixed label set. Budgeted (max_calls).
 *   doc_coding    fetch public pages, code each against a rubric TWICE
 *                 independently, report counts + inter-pass agreement.
 *
 * pipeline_self_test never runs here: it changes a live system, so it parks at
 * needs_operator for a human.
 *
 * Usage:
 *   node runner/experiment.js --list
 *   node runner/experiment.js --run <id> [--dry-run]
 *   node runner/experiment.js --preregister <spec.json>
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state");
const exps = require("./lib/experiments");

const MAX_CALLS_HARD = 400;
const MAX_URLS_HARD = 60;

function log(msg) { console.log(`[experiment] ${msg}`); }
const readJsonl = (p) => { try { return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fb; } };
const pct = (x) => Math.round(x * 1000) / 10;

// ── self_log computations ────────────────────────────────────────────────────

/** Stated confidence vs actual hit rate, by bucket. The 79/29 gap, measured. */
function calibration({ buckets = [[0, 50], [50, 70], [70, 85], [85, 101]] } = {}) {
  const rows = readJsonl(path.join(STATE, "prediction_log.jsonl"))
    .filter((r) => Number.isFinite(Number(r.confidence_pct)) && r.resolution_status);
  const scored = rows.filter((r) => ["correct", "wrong", "partial"].includes(r.resolution_status));
  const hit = (r) => (r.resolution_status === "correct" ? 1 : r.resolution_status === "partial" ? 0.5 : 0);
  const out = buckets.map(([lo, hi]) => {
    const inB = scored.filter((r) => Number(r.confidence_pct) >= lo && Number(r.confidence_pct) < hi);
    const stated = inB.length ? inB.reduce((s, r) => s + Number(r.confidence_pct), 0) / inB.length : null;
    const actual = inB.length ? (inB.reduce((s, r) => s + hit(r), 0) / inB.length) * 100 : null;
    return { bucket: `${lo}-${hi === 101 ? 100 : hi - 1}%`, n: inB.length, stated_mean: stated && Math.round(stated), actual_hit_rate: actual == null ? null : Math.round(actual), gap: stated == null ? null : Math.round(stated - actual) };
  });
  const all = scored.length
    ? { n: scored.length, stated_mean: Math.round(scored.reduce((s, r) => s + Number(r.confidence_pct), 0) / scored.length), actual_hit_rate: Math.round((scored.reduce((s, r) => s + hit(r), 0) / scored.length) * 100) }
    : { n: 0, stated_mean: null, actual_hit_rate: null };
  all.gap = all.stated_mean == null ? null : all.stated_mean - all.actual_hit_rate;
  return { overall: all, buckets: out, unresolved: rows.length - scored.length, note: "partial counts as 0.5" };
}

/** How concentrated an axis's evidence is — the capture check, on real data. */
function sourceConcentration({ axis_ids = null, top = 5 } = {}) {
  const onto = readJson(path.join(STATE, "ontology.json"), { axes: [] });
  const axes = (onto.axes || []).filter((a) => !axis_ids || axis_ids.includes(a.id));
  const host = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, ""); } catch { return String(u || "").slice(0, 40); } };
  const rows = axes.map((a) => {
    const ev = a.evidence_log || [];
    const counts = {};
    for (const e of ev) counts[host(e.source)] = (counts[host(e.source)] || 0) + 1;
    const ranked = Object.entries(counts).sort((x, y) => y[1] - x[1]);
    const total = ev.length || 1;
    return {
      axis_id: a.id, label: a.label, evidence: ev.length,
      distinct_sources: ranked.length,
      top_source_share: ranked.length ? pct(ranked[0][1] / total) : null,
      top: ranked.slice(0, top).map(([h, n]) => ({ host: h, n, share_pct: pct(n / total) })),
      from_research: ev.filter((e) => e.writer).length,
    };
  }).sort((a, b) => (b.top_source_share || 0) - (a.top_source_share || 0));
  return { axes: rows, worst_top_source_share: rows.length ? rows[0].top_source_share : null };
}

/** Generic group-by over one of his own files. */
function fieldCounts({ source, field }) {
  const FILES = {
    predictions: () => readJsonl(path.join(STATE, "prediction_log.jsonl")),
    cost: () => readJsonl(path.join(STATE, "cost_ledger.jsonl")),
    solutions: () => readJsonl(path.join(STATE, "solutions.jsonl")),
    findings: () => readJsonl(path.join(STATE, "knowledge", "findings.jsonl")),
    posts: () => { const d = readJson(path.join(STATE, "posts_log.json"), []); return Array.isArray(d) ? d : (d.posts || []); },
  };
  if (!FILES[source]) throw new Error(`unknown source "${source}" (use: ${Object.keys(FILES).join(", ")})`);
  const rows = FILES[source]();
  const counts = {};
  for (const r of rows) {
    const k = String((r || {})[field] === undefined ? "(missing)" : (r || {})[field]);
    counts[k] = (counts[k] || 0) + 1;
  }
  return { source, field, n: rows.length, counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25)) };
}

async function runSelfLog(rec) {
  const p = rec.procedure || {};
  if (p.compute === "calibration") return calibration(p);
  if (p.compute === "source_concentration") return sourceConcentration(p);
  if (p.compute === "field_counts") return fieldCounts(p);
  throw new Error(`unknown compute "${p.compute}" (use: calibration, source_concentration, field_counts)`);
}

// ── llm_trial ────────────────────────────────────────────────────────────────

async function runLlmTrial(rec, { dryRun }) {
  const p = rec.procedure || {};
  const items = Array.isArray(p.items) ? p.items
    : p.items_file ? readJsonl(path.join(ROOT, p.items_file))
    : [];
  if (!items.length) throw new Error("llm_trial needs procedure.items[] or procedure.items_file");
  const conditions = p.conditions && typeof p.conditions === "object" ? p.conditions : null;
  if (!conditions || !Object.keys(conditions).length) throw new Error("llm_trial needs procedure.conditions {name: promptTemplate}");
  const names = Object.keys(conditions);
  const n = Math.min(items.length, Number(rec.n) || items.length);
  const budget = Math.min(Number(p.max_calls) || (n * names.length * 2), MAX_CALLS_HARD);
  if (dryRun) return { dry_run: true, items: n, conditions: names, planned_calls: n * names.length, budget };

  const { reason } = require("./lib/compose");
  const scoring = p.score || { type: "judge", labels: ["yes", "no"], rubric: "Does the answer comply?" };
  let calls = 0;
  const results = {};
  for (const name of names) results[name] = { labels: {}, n: 0 };

  for (let i = 0; i < n; i++) {
    const item = typeof items[i] === "string" ? { text: items[i] } : items[i];
    for (const name of names) {
      if (calls + 1 > budget) { log(`budget reached (${budget} calls) — stopping at item ${i}`); i = n; break; }
      const prompt = String(conditions[name]).replace(/\{item\}/g, typeof item.text === "string" ? item.text : JSON.stringify(item));
      let answer = "";
      try { answer = await reason(prompt, { tag: `experiment:${rec.id}:${name}`, maxTokens: Number(p.max_tokens) || 400 }); calls++; }
      catch (e) { log(`trial ${i} (${name}) failed: ${e.message}`); continue; }

      let label = null;
      if (scoring.type === "regex") {
        label = new RegExp(scoring.pattern, scoring.flags || "i").test(answer) ? "match" : "no_match";
      } else {
        if (calls + 1 > budget) break;
        const labels = (scoring.labels || ["yes", "no"]).map(String);
        const judged = await reason(
          `${scoring.rubric}\n\nANSWER:\n${String(answer).slice(0, 2000)}\n\nReply with exactly one of: ${labels.join(" | ")}. One word, nothing else.`,
          { tag: `experiment:${rec.id}:judge`, maxTokens: 10 },
        ).catch(() => "");
        calls++;
        const hit = labels.find((l) => new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(judged)));
        label = hit || "unparsed";
      }
      results[name].labels[label] = (results[name].labels[label] || 0) + 1;
      results[name].n++;
    }
  }
  const primary = (scoring.primary_label || (scoring.labels || ["yes"])[0]);
  const rates = Object.fromEntries(names.map((name) => {
    const r = results[name];
    return [name, r.n ? pct((r.labels[primary] || 0) / r.n) : null];
  }));
  const diff = names.length === 2 && rates[names[1]] != null && rates[names[0]] != null
    ? Math.round((rates[names[1]] - rates[names[0]]) * 10) / 10 : null;
  return { conditions: results, primary_label: primary, rate_pct: rates, difference_pct: diff, calls };
}

// ── doc_coding ───────────────────────────────────────────────────────────────

async function runDocCoding(rec, { dryRun }) {
  const p = rec.procedure || {};
  const urls = (p.urls || []).slice(0, MAX_URLS_HARD);
  if (!urls.length) throw new Error("doc_coding needs procedure.urls[]");
  const labels = (p.labels || ["yes", "no", "unclear"]).map(String);
  const passes = Math.min(Math.max(Number(p.passes) || 2, 1), 3);
  if (dryRun) return { dry_run: true, urls: urls.length, passes, planned_calls: urls.length * passes };

  const { fetchPageText } = require("./lib/helmstack_fetch");
  const { reason } = require("./lib/compose");
  const rows = [];
  for (const url of urls) {
    let text = "";
    try { text = await fetchPageText(url, { maxChars: 6000 }); } catch (e) { log(`fetch failed ${url}: ${e.message}`); }
    if (!text) { rows.push({ url, fetched: false, codes: [] }); continue; }
    const codes = [];
    for (let k = 0; k < passes; k++) {
      const out = await reason(
        `Code this document against the rubric. Judge only what the text says.\n\nRUBRIC: ${p.rubric}\n\nDOCUMENT (${url}):\n${text}\n\nReply with exactly one of: ${labels.join(" | ")}. One word, nothing else.`,
        { tag: `experiment:${rec.id}:code`, maxTokens: 10 },
      ).catch(() => "");
      const hit = labels.find((l) => new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(out)));
      codes.push(hit || "unparsed");
    }
    rows.push({ url, fetched: true, codes });
  }
  const coded = rows.filter((r) => r.fetched && r.codes.length === passes);
  const agreed = coded.filter((r) => new Set(r.codes).size === 1);
  const counts = {};
  for (const r of agreed) counts[r.codes[0]] = (counts[r.codes[0]] || 0) + 1;
  return {
    documents: rows.length, fetched: rows.filter((r) => r.fetched).length,
    passes, agreement_pct: coded.length ? pct(agreed.length / coded.length) : null,
    counts_where_passes_agree: counts, rows,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run(id, { dryRun = false } = {}) {
  const rec = exps.get(id);
  if (!rec) { log(`no experiment ${id}`); return 1; }
  if (rec.kind === "pipeline_self_test") {
    log(`${id} is a pipeline self-test — it changes a live system, so it waits for the operator. Nothing run.`);
    return 2;
  }
  if (rec.status === "done") { log(`${id} already completed`); return 0; }

  if (!dryRun) exps.update(id, { status: "running", started_at: new Date().toISOString() });
  log(`running ${id} (${rec.kind}, n=${rec.n}) — ${rec.question}`);
  let data;
  try {
    data = rec.kind === "self_log" ? await runSelfLog(rec)
      : rec.kind === "llm_trial" ? await runLlmTrial(rec, { dryRun })
      : await runDocCoding(rec, { dryRun });
  } catch (e) {
    log(`failed: ${e.message}`);
    if (!dryRun) exps.update(id, { status: "planned", last_error: e.message });
    return 1;
  }
  if (dryRun) { console.log(JSON.stringify(data, null, 2)); return 0; }

  const dataFile = path.join(exps.DIR, `${id}.data.json`);
  fs.writeFileSync(dataFile, JSON.stringify({ id, ran_at: new Date().toISOString(), data }, null, 2), "utf-8");

  // The pre-registered criteria decide the verdict — a model reads them against
  // the data, and may only answer with one of three words.
  let verdict = "inconclusive";
  let summary = "";
  try {
    const { reason } = require("./lib/compose");
    const out = await reason(
      `An experiment was pre-registered and has now produced data. Apply its criteria literally — do not soften them, do not invent a criterion that was not registered.

QUESTION: ${rec.question}
HYPOTHESIS: ${rec.hypothesis}
METRIC: ${rec.metric}
SUCCESS CRITERION: ${rec.success_criterion}
FAILURE CRITERION: ${rec.failure_criterion}

DATA:
${JSON.stringify(data).slice(0, 6000)}

Return JSON only: {"verdict":"supported|not_supported|inconclusive","metric_value":<number or string>,"summary":"two sentences: what the metric came out at, and what it does NOT show"}`,
      { tag: `experiment:${rec.id}:verdict`, maxTokens: 400 },
    );
    const m = String(out).replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    if (["supported", "not_supported", "inconclusive"].includes(j.verdict)) verdict = j.verdict;
    summary = String(j.summary || "").slice(0, 600);
    var metricValue = j.metric_value;
  } catch (e) { log(`verdict pass failed (recorded inconclusive): ${e.message}`); }

  const done = exps.complete(id, { verdict, metric_value: typeof metricValue === "undefined" ? null : metricValue, summary, data_file: path.relative(ROOT, dataFile) });
  if (!done.ok) { log(`could not record: ${done.errors.join("; ")}`); return 1; }

  // Tell the writing layer, the same way a published brief does. A result that
  // did not support the hypothesis is worth saying out loud, not burying.
  try {
    const config = require("./lib/config");
    fs.appendFileSync(config.BROWSE_NOTES_PATH,
      `- [EXPERIMENT ${verdict}] ${rec.question} — ${summary || rec.metric}\n`);
  } catch { /* non-fatal */ }

  log(`recorded ${id}: ${verdict}`);
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  (async () => {
    if (argv.includes("--list")) {
      for (const r of exps.list()) console.log(`${r.status.padEnd(15)} ${r.id}  ${r.question.slice(0, 80)}`);
      return 0;
    }
    const specFile = arg("--preregister");
    if (specFile) {
      const spec = readJson(path.resolve(specFile));
      if (!spec) { log(`could not read ${specFile}`); return 1; }
      const r = exps.preregister(spec);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    const id = arg("--run");
    if (!id) { console.log("usage: experiment.js --list | --run <id> [--dry-run] | --preregister <spec.json>"); return 1; }
    return run(id, { dryRun: argv.includes("--dry-run") });
  })().then((code) => process.exit(code || 0)).catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
}

module.exports = { run, calibration, sourceConcentration, fieldCounts };
