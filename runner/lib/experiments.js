"use strict";
/**
 * runner/lib/experiments.js — pre-registered experiments: the record layer.
 *
 * A solution brief states a falsifiable test. Until now nothing could RUN one,
 * so every proposal stayed at "proposed — not yet tested" forever. This is the
 * register: an experiment is written down BEFORE it runs (question, hypothesis,
 * metric, success and failure criteria, n), and the result is recorded against
 * that registration, whatever it says.
 *
 * Pre-registration is not ceremony here. Sebastian's own record is 79% stated
 * confidence against a 29% hit rate; an experiment whose criteria can be edited
 * after seeing the data would inherit exactly that failure. Once status leaves
 * "planned", question/hypothesis/metric/criteria/n are frozen — `record()`
 * refuses to change them, and the result carries `preregistered_at`.
 *
 * KINDS (what the runtime can actually execute — see runner/experiment.js):
 *   self_log            measurement over his own history (predictions, evidence,
 *                       posts, cost ledger, knowledge base). No external calls.
 *   llm_trial           N items x conditions through the model, scored
 *                       mechanically or by a judge with a fixed label set.
 *   doc_coding          fetch public documents, code them against a rubric twice
 *                       independently, report counts and inter-pass agreement.
 *   pipeline_self_test  a change to his own pipeline. NEVER auto-runs: it is a
 *                       code change to a live system, so it parks at
 *                       "needs_operator" until a human runs and records it.
 *
 * Results go to the knowledge base as kind "experiment" — first-party, with a
 * stated metric and a criterion it could have failed. That is the strongest
 * evidence this system can produce, and a null result is a result: it is
 * published the same way.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, "state", "experiments");

const KINDS = ["self_log", "llm_trial", "doc_coding", "pipeline_self_test"];
const STATUSES = ["planned", "needs_operator", "running", "done", "abandoned"];
/** Frozen once the experiment leaves "planned". */
const FROZEN = ["question", "hypothesis", "kind", "metric", "success_criterion", "failure_criterion", "n", "procedure"];

function log(msg) { console.log(`[experiments] ${msg}`); }

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
}

function pathFor(id) { return path.join(DIR, `${id}.json`); }

function list() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf-8")); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function get(id) {
  try { return JSON.parse(fs.readFileSync(pathFor(id), "utf-8")); } catch { return null; }
}

function write(rec) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(pathFor(rec.id), JSON.stringify(rec, null, 2), "utf-8");
  return rec;
}

/** Mechanical validation — a spec that cannot fail is not an experiment. */
function validate(spec) {
  const errs = [];
  const need = (k) => { if (!String((spec || {})[k] || "").trim()) errs.push(`missing ${k}`); };
  need("question"); need("hypothesis"); need("metric");
  need("success_criterion"); need("failure_criterion");
  if (!KINDS.includes((spec || {}).kind)) errs.push(`kind must be one of ${KINDS.join(", ")}`);
  const n = Number((spec || {}).n);
  if (!Number.isFinite(n) || n < 1) errs.push("n must be a positive number of trials/items");
  if (!(spec || {}).procedure || typeof spec.procedure !== "object") errs.push("missing procedure");
  if (String(spec.success_criterion || "").trim() === String(spec.failure_criterion || "").trim())
    errs.push("success and failure criteria are identical — the experiment cannot fail");
  return errs;
}

/**
 * Register an experiment before it runs. Returns { ok, id, errors }.
 * A pipeline_self_test parks at needs_operator: it changes a live system.
 */
function preregister(spec, { track = null, from_brief = null } = {}) {
  const errors = validate(spec);
  if (errors.length) return { ok: false, errors };
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const id = spec.id || `exp_${day}_${slug(spec.question)}`.slice(0, 64);
  if (get(id)) return { ok: false, errors: [`experiment ${id} already registered`], id };
  const rec = {
    id,
    preregistered_at: new Date().toISOString(),
    status: spec.kind === "pipeline_self_test" ? "needs_operator" : "planned",
    question: spec.question,
    hypothesis: spec.hypothesis,
    kind: spec.kind,
    track: track || spec.track || null,
    from_brief: from_brief || spec.from_brief || null,
    metric: spec.metric,
    success_criterion: spec.success_criterion,
    failure_criterion: spec.failure_criterion,
    n: Number(spec.n),
    procedure: spec.procedure,
    result: null,
    published_url: null,
    notes: spec.notes || null,
  };
  write(rec);
  log(`registered ${id} (${rec.kind}, status ${rec.status})`);
  return { ok: true, id, record: rec };
}

/** Update a registered experiment. Frozen fields cannot move after "planned". */
function update(id, patch = {}) {
  const rec = get(id);
  if (!rec) return { ok: false, errors: [`no experiment ${id}`] };
  if (rec.status !== "planned") {
    const frozen = FROZEN.filter((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(rec[k]));
    if (frozen.length) {
      return { ok: false, errors: [`cannot change ${frozen.join(", ")} after pre-registration (status ${rec.status})`] };
    }
  }
  if (patch.status && !STATUSES.includes(patch.status)) return { ok: false, errors: [`bad status ${patch.status}`] };
  const next = { ...rec, ...patch, updated_at: new Date().toISOString() };
  write(next);
  return { ok: true, record: next };
}

/**
 * Record a result against the registration and push it to the knowledge base.
 * verdict: supported | not_supported | inconclusive — decided by the
 * pre-registered criteria, not by how the result reads.
 */
function complete(id, { verdict, metric_value, summary, data_file = null, published_url = null }) {
  const rec = get(id);
  if (!rec) return { ok: false, errors: [`no experiment ${id}`] };
  if (!["supported", "not_supported", "inconclusive"].includes(verdict))
    return { ok: false, errors: ["verdict must be supported | not_supported | inconclusive"] };
  const result = {
    verdict,
    metric_value: metric_value === undefined ? null : metric_value,
    summary: String(summary || "").slice(0, 600),
    data_file,
    completed_at: new Date().toISOString(),
  };
  const next = { ...rec, status: "done", result, published_url: published_url || rec.published_url };
  write(next);
  try {
    require("./knowledge_base").recordExperiment({
      id: rec.id, question: rec.question, track: rec.track, hypothesis: rec.hypothesis,
      metric: rec.metric, verdict, metric_value: result.metric_value,
      summary: result.summary, url: next.published_url, n: rec.n,
      preregistered_at: rec.preregistered_at,
    });
  } catch (e) { log(`knowledge record failed (non-fatal): ${e.message}`); }
  log(`${id}: ${verdict}${result.metric_value != null ? ` (${JSON.stringify(result.metric_value)})` : ""}`);
  return { ok: true, record: next };
}

/** Compact block for planning prompts: what is registered, running, and done. */
function experimentsBlock(limit = 8) {
  const rows = list();
  if (!rows.length) return "";
  const open = rows.filter((r) => r.status === "planned" || r.status === "running");
  const waiting = rows.filter((r) => r.status === "needs_operator");
  const done = rows.filter((r) => r.status === "done").slice(-limit);
  const lines = [];
  if (open.length) lines.push(...open.map((r) => `- REGISTERED, not yet run: ${r.question} (metric: ${r.metric})`));
  if (waiting.length) lines.push(...waiting.map((r) => `- WAITING ON THE OPERATOR (pipeline change): ${r.question}`));
  if (done.length) lines.push(...done.map((r) => `- RESULT (${r.result.verdict}): ${r.question} — ${r.result.summary.slice(0, 160)}`));
  return lines.length ? `── EXPERIMENTS ──\n${lines.join("\n")}` : "";
}

module.exports = { preregister, update, complete, get, list, validate, experimentsBlock, KINDS, DIR };
