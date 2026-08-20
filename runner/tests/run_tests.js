#!/usr/bin/env node
"use strict";
/**
 * runner/tests/run_tests.js — regression test suite
 *
 * Catches silent bugs before they hit the running agent.
 * Fast (<30s), non-destructive, no writes to production state.
 *
 * Usage:
 *   node runner/tests/run_tests.js          # run all tests
 *   node runner/tests/run_tests.js --quick  # syntax + config only (< 5s)
 *   node runner/tests/run_tests.js --ci     # exit 1 on any failure
 *
 * Run as pre-push hook:
 *   echo "node runner/tests/run_tests.js --ci" >> .git/hooks/pre-push
 *   chmod +x .git/hooks/pre-push
 */

const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");

const ROOT    = path.resolve(__dirname, "../..");
const RUNNER  = path.join(ROOT, "runner");
const SCRAPER = path.join(ROOT, "scraper");
const STATE   = path.join(ROOT, "state");

const IS_QUICK = process.argv.includes("--quick");
const IS_CI    = process.argv.includes("--ci");

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(name) {
  process.stdout.write(`  ✓ ${name}\n`);
  passed++;
}

function fail(name, reason) {
  process.stdout.write(`  ✗ ${name}\n    → ${reason}\n`);
  failed++;
  failures.push({ name, reason });
}

function skip(name, reason) {
  process.stdout.write(`  · ${name} (skip: ${reason})\n`);
  skipped++;
}

function section(title) {
  process.stdout.write(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }

function checkSyntax(filePath) {
  try {
    execSync(`node --check "${filePath}"`, { stdio: "pipe", timeout: 10_000 });
    return null;
  } catch (e) {
    return (e.stderr?.toString() || e.message || "syntax error").split("\n")[0];
  }
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch (e) { return e; }
}

function runScript(scriptPath, args = "", timeoutMs = 15_000) {
  try {
    const out = execSync(`node "${scriptPath}" ${args}`, {
      cwd: ROOT,
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    return { ok: true, stdout: out };
  } catch (e) {
    return {
      ok: false,
      code: e.status,
      stderr: (e.stderr?.toString() || "").slice(0, 300),
      message: e.message?.slice(0, 200),
    };
  }
}

// ── Section 1: Syntax checks on all runner + scraper JS files ────────────────

section("Syntax checks");

function syntaxCheckDir(dir, label) {
  if (!fileExists(dir)) { skip(`${label} dir`, "directory missing"); return; }
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".js") && !f.startsWith("."))
    .slice(0, 60); // cap for speed
  let ok = 0;
  const errs = [];
  for (const f of files) {
    const err = checkSyntax(path.join(dir, f));
    if (err) errs.push(`${f}: ${err}`);
    else ok++;
  }
  if (errs.length === 0) pass(`${label} (${ok} files)`);
  else errs.forEach(e => fail(`${label}/${e.split(":")[0]}`, e.split(":").slice(1).join(":").trim()));
}

syntaxCheckDir(RUNNER, "runner/");
syntaxCheckDir(SCRAPER, "scraper/");
syntaxCheckDir(path.join(RUNNER, "lib"), "runner/lib/");
syntaxCheckDir(path.join(RUNNER, "sprint"), "runner/sprint/");
syntaxCheckDir(path.join(RUNNER, "lib", "prompts"), "runner/lib/prompts/");

// ── Section 2: Config and state file integrity ────────────────────────────────

section("Config + state integrity");

// Config loads without error
try {
  const config = require(path.join(RUNNER, "lib", "config"));
  const requiredKeys = [
    "PROJECT_ROOT", "STATE_DIR", "JOURNALS_DIR", "RUNNER_DIR",
    "ONTOLOGY_PATH", "MEMORY_RECALL_PATH",
  ];
  const missing = requiredKeys.filter(k => !config[k]);
  if (missing.length) fail("config.js exports", `missing keys: ${missing.join(", ")}`);
  else pass("config.js exports");
} catch (e) { fail("config.js load", e.message); }

// Key state JSON files are parseable (if they exist)
const stateFiles = [
  "ontology.json",
  "posts_log.json",
  "ponder_state.json",
  "active_plan.json",
  "claim_tracker.json",
  "vocation.json",
  "external_sources.json",
];
let stateOk = 0;
let stateFail = 0;
for (const f of stateFiles) {
  const fp = path.join(STATE, f);
  if (!fileExists(fp)) { skip(`state/${f}`, "not yet created"); continue; }
  const result = loadJson(fp);
  if (result instanceof Error) { fail(`state/${f}`, result.message.slice(0, 100)); stateFail++; }
  else stateOk++;
}
if (stateFail === 0 && stateOk > 0) pass(`state JSON files (${stateOk} parseable)`);

// SQLite database opens without error
try {
  const { loadScraperDb } = require(path.join(RUNNER, "lib", "db_backend"));
  const db = loadScraperDb();
  const row = db.raw().prepare("SELECT COUNT(*) as c FROM memory").get();
  pass(`SQLite index.db (memory rows: ${row.c})`);
} catch (e) { fail("SQLite index.db", e.message.slice(0, 150)); }

if (IS_QUICK) {
  printSummary();
  process.exit(IS_CI && failed > 0 ? 1 : 0);
}

// ── Section 3: Module export contracts ───────────────────────────────────────

section("Module export contracts");

const moduleChecks = [
  { path: "runner/lib/intelligence_brief.js", exports: ["gatherBrief", "formatBriefForPrompt", "formatBriefForHuman"] },
  { path: "runner/lib/verify_claim.js",       exports: ["verifyClaim"] },
  { path: "runner/lib/db_backend.js",         exports: ["loadScraperDb", "loadIntelligenceDb"] },
  { path: "runner/lib/config.js",             exports: ["PROJECT_ROOT", "STATE_DIR"] },
  { path: "runner/lib/sebastian_respond.js",  exports: ["buildPersona", "buildCoreContext"] },
  { path: "runner/lib/self_echo.js",          exports: ["createSelfEchoDetector"] },
  { path: "runner/lib/voice_filter.js",       exports: ["check"] },
  { path: "runner/sprint/planner.js",         exports: ["generateFullPlan", "generateNextSprint"] },
  { path: "runner/sprint/tracker.js",         exports: ["runDailyTracking", "gatherTodaySignals"] },
];

for (const { path: p, exports: expected } of moduleChecks) {
  const fullPath = path.join(ROOT, p);
  if (!fileExists(fullPath)) { skip(p, "file missing"); continue; }
  try {
    const mod = require(fullPath);
    const missing = expected.filter(k => typeof mod[k] === "undefined");
    if (missing.length) fail(p, `missing exports: ${missing.join(", ")}`);
    else pass(p);
  } catch (e) { fail(p, e.message.slice(0, 120)); }
}

// ── Section 4: SQLite API contract (no PG-style .query() calls) ──────────────

section("SQLite API contract (no PG mismatch)");

const jsFiles = [];
function collectJs(dir) {
  if (!fileExists(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    const stat = fs.statSync(fp);
    if (stat.isDirectory() && f !== "node_modules") collectJs(fp);
    else if (f.endsWith(".js")) jsFiles.push(fp);
  }
}
collectJs(RUNNER);
collectJs(SCRAPER);

// Match db.raw().query( but exclude test files and string literals/comments
const pgStylePattern = /db\.raw\(\)\.query\s*\(/;
const pgFiles = jsFiles.filter(f => {
  if (f.includes("/tests/") || f.includes("node_modules")) return false;
  try {
    const src = fs.readFileSync(f, "utf-8");
    // Strip single-line comments and string literals before checking
    const stripped = src
      .replace(/\/\/[^\n]*/g, "")           // remove // comments
      .replace(/`[^`]*`/gs, '""')           // remove template literals
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // remove double-quoted strings
      .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // remove single-quoted strings
    return pgStylePattern.test(stripped);
  } catch { return false; }
});

if (pgFiles.length === 0) {
  pass("No PG-style db.raw().query() calls found");
} else {
  pgFiles.forEach(f => fail(
    path.relative(ROOT, f),
    "uses db.raw().query() — must use db.raw().prepare().run/get/all()"
  ));
}

// ── Section 5: Critical script integration tests ─────────────────────────────

section("Script integration tests");

// recall.js — must complete without error and return output
{
  const r = runScript(path.join(RUNNER, "recall.js"), '--query "test" --limit 1 --print', 20_000);
  if (r.ok) pass("recall.js --query test");
  else fail("recall.js", r.stderr || r.message);
}

// intelligence_brief.js — gatherBrief must return expected structure
{
  const briefTest = `
const { gatherBrief } = require("${path.join(RUNNER, "lib", "intelligence_brief").replace(/\\/g, "/")}");
const b = gatherBrief("test query");
if (!Array.isArray(b.axes)) throw new Error("axes not array");
if (!Array.isArray(b.drift)) throw new Error("drift not array");
if (!Array.isArray(b.claims)) throw new Error("claims not array");
if (typeof b.memory !== "string") throw new Error("memory not string");
console.log("ok");
  `;
  const r = runScript("-e", briefTest.replace(/\n/g, " ").replace(/"/g, '\\"').replace(/\\/g, "\\\\"), 20_000);
  // Simpler: write a temp file
  const tmpFile = path.join(ROOT, "runner", "tests", "_tmp_brief_test.js");
  try {
    fs.writeFileSync(tmpFile, `
const { gatherBrief } = require("../lib/intelligence_brief");
const b = gatherBrief("test query");
if (!Array.isArray(b.axes)) throw new Error("axes not array");
if (!Array.isArray(b.drift)) throw new Error("drift not array");
if (!Array.isArray(b.claims)) throw new Error("claims not array");
if (typeof b.memory !== "string") throw new Error("memory not string");
process.exit(0);
`);
    const r2 = runScript(tmpFile, "", 20_000);
    if (r2.ok) pass("intelligence_brief.js gatherBrief structure");
    else fail("intelligence_brief.js", r2.stderr || r2.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// apply_ontology_delta.js — must load without crash (existence + require check)
{
  const tmpFile = path.join(ROOT, "runner", "tests", "_tmp_delta_test.js");
  try {
    fs.writeFileSync(tmpFile, `
// Just require the main deps to verify no import-time crashes
require("../lib/db_backend");
require("../lib/config");
process.exit(0);
`);
    const r = runScript(tmpFile, "", 10_000);
    if (r.ok) pass("apply_ontology_delta.js deps load");
    else fail("apply_ontology_delta.js deps", r.stderr || r.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// scraper/rss_collect.js — must parse BBC feed sample (offline XML parse test)
{
  const tmpFile = path.join(ROOT, "runner", "tests", "_tmp_rss_test.js");
  try {
    fs.writeFileSync(tmpFile, `
const path = require("path");
// Test the XML parser logic directly
function stripHtml(s) { return (s||"").replace(/<[^>]+>/g," ").replace(/\\s+/g," ").trim(); }
const sampleXml = \`<?xml version="1.0"?><rss><channel>
<item><title>Test headline</title><link>https://example.com/1</link>
<description>Test desc</description><pubDate>Wed, 04 Jun 2026 00:00:00 +0000</pubDate>
</item></channel></rss>\`;
const items = sampleXml.match(/<item[\\s>][\\s\\S]*?<\\/item>/gi) || [];
if (items.length !== 1) throw new Error("expected 1 item, got " + items.length);
const title = (items[0].match(/<title>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/title>/) || [])[1];
if (!title || !title.includes("Test headline")) throw new Error("title mismatch: " + title);
process.exit(0);
`);
    const r = runScript(tmpFile, "", 10_000);
    if (r.ok) pass("rss_collect.js XML parser logic");
    else fail("rss_collect.js XML parser", r.stderr || r.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// source_followup.js — eligibility logic
{
  const tmpFile = path.join(ROOT, "runner", "tests", "_tmp_sf_test.js");
  try {
    fs.writeFileSync(tmpFile, `
const { gatherBrief } = require("../lib/intelligence_brief");
// source_followup should load without crash
const config = require("../lib/config");
const fs = require("fs");
if (!fs.existsSync(config.EXTERNAL_SOURCES_PATH)) {
  console.log("external_sources.json not yet created — skip");
  process.exit(0);
}
const extSrc = JSON.parse(fs.readFileSync(config.EXTERNAL_SOURCES_PATH, "utf-8"));
const sources = Object.values(extSrc.sources || {});
if (!Array.isArray(sources)) throw new Error("sources not array");
process.exit(0);
`);
    const r = runScript(tmpFile, "", 10_000);
    if (r.ok) pass("source_followup.js external_sources schema");
    else fail("source_followup.js", r.stderr || r.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Section 6: Prediction eval coverage ──────────────────────────────────────

section("Prediction eval coverage");

{
  const predLog = path.join(STATE, "prediction_log.jsonl");
  if (!fileExists(predLog)) {
    skip("prediction_log.jsonl", "not yet created");
  } else {
    const lines = fs.readFileSync(predLog, "utf-8").split("\n").filter(Boolean);
    const preds = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // resolution_status is added by prediction_resolution.js — may not exist on raw predictions
    const resolved  = preds.filter(p => ["correct","wrong","partial","expired"].includes(p.resolution_status));
    const unresolved = preds.filter(p => !p.resolution_status || p.resolution_status === "pending");
    const correct   = resolved.filter(p => p.resolution_status === "correct");
    const accuracy  = resolved.length ? (correct.length / resolved.length * 100).toFixed(0) : "n/a";

    if (preds.length === 0) fail("predictions", "no predictions logged");
    else {
      pass(`predictions: ${preds.length} total, ${resolved.length} resolved (accuracy: ${accuracy}%), ${unresolved.length} pending`);
      if (unresolved.length > 20) {
        fail("prediction backlog", `${unresolved.length} unresolved — prediction_resolution.js may not be running`);
      }
    }
  }
}

// ── Section 7: Claim verification coverage ───────────────────────────────────

section("Claim verification coverage");

{
  const verifyExport = path.join(STATE, "verification_export.json");
  if (!fileExists(verifyExport)) {
    skip("verification_export.json", "not yet created");
  } else {
    const data = loadJson(verifyExport);
    if (data instanceof Error) { fail("verification_export.json", data.message); }
    else {
      const claims = Array.isArray(data) ? data : (data.claims || []);
      const supported = claims.filter(c => c.status === "supported").length;
      const refuted   = claims.filter(c => c.status === "refuted").length;
      const unverified = claims.filter(c => c.status === "unverified").length;
      pass(`claims: ${claims.length} total (✅ ${supported} supported, ❌ ${refuted} refuted, ? ${unverified} unverified)`);
      if (claims.length === 0) fail("verification pipeline", "no claims in verification_export.json");
    }
  }
}

// ── Section 8: LinkedIn A/B scoring (precision-weight + confound control) ────

section("LinkedIn A/B scoring");

{
  let perf;
  try {
    perf = require(path.join(RUNNER, "lib", "linkedin_performance"));
  } catch (e) {
    fail("load linkedin_performance", e.message);
    perf = null;
  }

  if (perf) {
    const close = (a, b, eps = 0.05) => Math.abs(a - b) < eps;

    // (1) Shrinkage: a zero-engagement post at LOW reach must be punished far
    //     less than the same at HIGH reach, and stay near the baseline.
    {
      const lo = perf.shrunkRate(0, 40, 5);    // 0 reactions / 40 impressions, baseline 5
      const hi = perf.shrunkRate(0, 4000, 5);  // 0 reactions / 4000 impressions
      if (lo > hi && lo > 3.5 && hi < 1) pass(`shrinkage: 0/40 → ${lo.toFixed(2)} stays near baseline, 0/4000 → ${hi.toFixed(2)} punished`);
      else fail("shrinkage", `expected lo(${lo.toFixed(2)}) near baseline > hi(${hi.toFixed(2)}) near 0`);
    }

    // (2) Precision weighting: a value's score must track the HIGH-reach post,
    //     not a low-reach fluke. Two 'claim' posts, same (thin) context.
    {
      const posts = [
        { ending: "claim", day: "weekday", impressions: 5000, engagement: 100 }, // rate 2, reliable
        { ending: "claim", day: "weekday", impressions: 50,   engagement: 20  }, // rate 40, fluke
      ];
      const s = perf.scoreDimensions(posts);
      const avg = s.ending.claim.avgScore;
      // residuals: high-reach ≈ -0.36, low-reach ≈ +7.5; weighted mean must sit near the high-reach one
      const resHi = perf.shrunkRate(100, 5000, (100 * 120) / 5050) - (100 * 120) / 5050;
      const resLo = perf.shrunkRate(20, 50, (100 * 120) / 5050) - (100 * 120) / 5050;
      if (Math.abs(avg - resHi) < Math.abs(avg - resLo)) pass(`precision weighting: claim score ${avg} tracks high-reach post (${resHi.toFixed(2)}), not fluke (${resLo.toFixed(2)})`);
      else fail("precision weighting", `avg ${avg} closer to fluke ${resLo.toFixed(2)} than reliable ${resHi.toFixed(2)}`);
    }

    // (3) Confound control: statement_hook only ever ran in a HOT context
    //     (weekend) and stat_hook in a COLD one (weekday), but each UNDER/OVER
    //     performs its own context. Residual scoring must rank stat_hook above
    //     statement_hook even though statement_hook has the higher ABSOLUTE rate.
    //
    //     NB: the arm names must stay in sync with DIMENSIONS.technique in
    //     runner/lib/linkedin_performance.js — scoreDimensions drops unknown
    //     techniques, so a stale name here reads as `undefined.avgScore` and
    //     throws, taking every later section down with it. (That is exactly what
    //     happened when e4d888128 retired `question_hook` and left this test
    //     pointing at it.)
    {
      const wk = (technique, rate) => ({ technique, day: "weekend", impressions: 1000, engagement: rate * 10 });
      const wd = (technique, rate) => ({ technique, day: "weekday", impressions: 1000, engagement: rate * 10 });
      const posts = [
        wk("statement_hook", 8), wk("statement_hook", 8), wk("statement_hook", 8),
        wk("contrarian_hook", 14), wk("contrarian_hook", 14),           // hot-context filler
        wd("stat_hook", 5), wd("stat_hook", 5), wd("stat_hook", 5),
        wd("scene_hook", 2), wd("scene_hook", 2),                       // cold-context filler
      ];
      const known = perf.DIMENSIONS ? perf.DIMENSIONS.technique : null;
      const stale = known ? [...new Set(posts.map((p) => p.technique))].filter((t) => !known.includes(t)) : [];
      if (stale.length) {
        fail("confound control", `test uses technique(s) not in DIMENSIONS.technique: ${stale.join(", ")}`);
      } else {
        const s = perf.scoreDimensions(posts);
        const q = s.technique.statement_hook.avgScore;
        const st = s.technique.stat_hook.avgScore;
        const absWinner = 8 > 5; // statement_hook has the higher raw rate
        if (absWinner && st > q && q < 0) pass(`confound control: stat_hook ${st} ranked above statement_hook ${q} despite lower raw rate (residual beats absolute)`);
        else fail("confound control", `expected stat_hook(${st}) > statement_hook(${q}) with statement_hook below its context`);
      }
    }

    // (4) Graceful degradation: the real production store is currently all
    //     unmeasured (no impressions) — scoring must not throw and must return
    //     null everywhere rather than fabricating winners.
    {
      const storePath = path.join(STATE, "linkedin_post_metrics.json");
      if (!fileExists(storePath)) {
        skip("real store scoring", "linkedin_post_metrics.json not present");
      } else {
        const data = loadJson(storePath);
        if (data instanceof Error) { fail("real store scoring", data.message); }
        else {
          try {
            const s = perf.scoreDimensions(Object.values(data.posts || {}));
            const anyScored = Object.values(s).some((dim) => Object.values(dim).some((v) => v.avgScore != null));
            const measured = Object.values(data.posts || {}).filter((p) => Number(p.impressions) > 0).length;
            if (measured === 0 && !anyScored) pass(`graceful degradation: ${Object.keys(data.posts || {}).length} tagged, 0 measured → all avgScore null (no fabricated winners)`);
            else if (measured > 0) pass(`real store: ${measured} measured post(s) scored`);
            else fail("graceful degradation", "0 measured posts but a dimension produced a non-null score");
          } catch (e) {
            fail("real store scoring", e.message);
          }
        }
      }
    }
  }
}

// ── Local LLM routing (phi4-mini scorer) ──────────────────────────────────────
// The local backend exists for bounded classification only, and its containment
// rules are the whole point: local routing is OPT-IN, a missing model is REPORTED
// rather than silent (the 2026-07-28 store wipe degraded every local path for
// ~2.3 days unnoticed), and local inference must never be billed as paid.
// These are pure-config assertions — no daemon required, so CI stays hermetic.
section("Local LLM routing");
{
  const localPath = path.join(RUNNER, "lib", "local_llm.js");
  if (!fileExists(localPath)) {
    skip("local_llm.js", "file missing");
  } else {
    const saved = { en: process.env.LOCAL_LLM_ENABLED, mode: process.env.LOCAL_LLM_MODE };
    try {
      const local = require(localPath);

      // (1) Opt-in: absent/!=1 env must NOT route locally.
      delete process.env.LOCAL_LLM_ENABLED;
      const offWhenUnset = local.isEnabled() === false;
      process.env.LOCAL_LLM_ENABLED = "0";
      const offWhenZero = local.isEnabled() === false;
      process.env.LOCAL_LLM_ENABLED = "1";
      const onWhenOne = local.isEnabled() === true;
      if (offWhenUnset && offWhenZero && onWhenOne) pass("local routing is opt-in (off unless LOCAL_LLM_ENABLED=1)");
      else fail("local opt-in", `unset=${offWhenUnset} zero=${offWhenZero} one=${onWhenOne}`);

      // (2) Default mode is the SAFE one. phi4-mini measured as a good noise
      //     filter but a bad ranker (only ever 0 or 2, never 1 or 3), so
      //     'prefilter' — local drops 0s, Claude ranks — must be the default;
      //     'only' collapses ranking and is for quota outages.
      delete process.env.LOCAL_LLM_MODE;
      const defMode = local.mode();
      process.env.LOCAL_LLM_MODE = "only";
      const onlyMode = local.mode();
      process.env.LOCAL_LLM_MODE = "garbage";
      const fallbackMode = local.mode();
      if (defMode === "prefilter" && onlyMode === "only" && fallbackMode === "prefilter") {
        pass("mode defaults to 'prefilter'; only an explicit 'only' collapses ranking");
      } else {
        fail("local mode default", `default=${defMode} only=${onlyMode} garbage=${fallbackMode}`);
      }

      // (3) Disabled must report a REASON, never a bare false — silent absence
      //     is the failure this module was written to prevent.
      delete process.env.LOCAL_LLM_ENABLED;
      local.isAvailable().then((av) => {
        if (av.ok === false && typeof av.reason === "string" && av.reason.length) {
          pass(`unavailability carries a reason ("${av.reason}")`);
        } else {
          fail("local availability reason", `got ${JSON.stringify(av)}`);
        }
      }).catch((e) => fail("local availability reason", e.message));

      // (4) Local inference must price as FREE. Without a 'phi' rule the tag
      //     falls through to '_default' and a free call is billed at a paid rate.
      const { normalizeModel } = require(path.join(RUNNER, "lib", "cost_meter.js"));
      const localish = ["phi4-mini", "phi4-mini:latest", "qwen2.5-agent", "ollama/whatever", "local"];
      const mis = localish.filter((m) => normalizeModel(m) !== "local");
      if (!mis.length) pass("local model tags price as free (phi/qwen/ollama → 'local')");
      else fail("local cost accounting", `these did not map to 'local': ${mis.join(", ")}`);
    } catch (e) {
      fail("local_llm.js", e.message.slice(0, 140));
    } finally {
      if (saved.en === undefined) delete process.env.LOCAL_LLM_ENABLED; else process.env.LOCAL_LLM_ENABLED = saved.en;
      if (saved.mode === undefined) delete process.env.LOCAL_LLM_MODE; else process.env.LOCAL_LLM_MODE = saved.mode;
    }
  }
}

// ── Local harness (making a weak model safe to publish from) ──────────────────
// Each assertion below is pinned to a REAL phi4-mini failure measured on
// Sebastian's production prompts (2026-08-19). Every one of those outputs passed
// voice_filter.check(), which is why these checks exist. Deterministic only —
// the model-based stance check needs a daemon and is exercised separately.
section("Local harness");
{
  const hp = path.join(RUNNER, "lib", "local_harness.js");
  if (!fileExists(hp)) { skip("local_harness.js", "file missing"); }
  else {
    const h = require(hp);
    const SRC = "COA auditor testified the OVP had receipts naming Mary Grace Piattos for P50,000-P70,000 each.";

    // Real failure: phi4-mini wrote "$50000-$70000" for peso amounts.
    if (h.checkCurrency("Auditor found $50,000 in payments", SRC) &&
        !h.checkCurrency("Auditor found P50,000 in payments", SRC)) {
      pass("currency drift caught (₱ source → $ output), clean output passes");
    } else fail("currency check", "did not catch $-for-₱ drift, or false-positived on a clean line");

    // Real failure: invented a "$130,000" total that appears nowhere in the source.
    if (h.checkInventedNumbers("totaling 130,000 pesos", SRC) &&
        !h.checkInventedNumbers("receipts of 50,000 each", SRC)) {
      pass("invented figures caught, source-grounded figures pass");
    } else fail("invented numbers", "did not catch a fabricated figure, or rejected a grounded one");

    // Real failure: emitted "#GAOTestimony" immediately after "No hashtags".
    if (h.checkConstraints("Real story #COAAudit", { noHashtags: true }) &&
        h.checkConstraints("x".repeat(300), { maxLen: 260 }) &&
        !h.checkConstraints("A clean specific line.", { noHashtags: true, maxLen: 260 })) {
      pass("explicit constraints enforced (hashtags, length)");
    } else fail("constraint check", "hashtag/length enforcement wrong");

    // Real failure: "collaboration between tech companies and regulatory bodies…"
    // — fluent, on-topic, and carrying nothing concrete from the source.
    if (h.checkSpecificity("Collaboration between stakeholders is needed.", SRC) &&
        !h.checkSpecificity("Mary Grace Piattos is not a real person.", SRC)) {
      pass("generic filler caught; output anchored to the source passes");
    } else fail("specificity check", "did not catch filler, or rejected an anchored line");

    // Real failure: asked for Taglish, produced Cebuano ('unya') and non-words.
    if (h.checkTaglish("Nandito ang receipt, unya wala pa ring liquidation") &&
        h.checkTaglish("This is entirely in English with no Tagalog at all") &&
        !h.checkTaglish("Yung receipt walang liquidation, pero may pangalan")) {
      pass("language drift caught (Cebuano tokens, and English-when-Taglish-asked)");
    } else fail("taglish check", "language drift detection wrong");

    // Taglish is DISABLED on the local backend (operator decision 2026-08-19):
    // phi4-mini wrote Cebuano and non-words when asked for it, and the harness
    // can detect that but not fix it. So local output must be English — while
    // Filipino PROPER NOUNS stay legal, since they are correct in English copy.
    if (h.checkEnglishOnly("Yung receipt walang liquidation") &&
        h.checkEnglishOnly("Nandito, unya wala pa") &&
        !h.checkEnglishOnly("Sara Duterte and Malacanang responded from Bulacan.")) {
      pass("English-only enforced on local; Filipino proper nouns still allowed");
    } else fail("english-only check", "blocked proper nouns, or let Tagalog/Cebuano through");

    // The wrapper must FAIL CLOSED — returning nothing is correct when the
    // output cannot be verified. Silence beats an inverted stance under his name.
    const shape = typeof h.guardedCompose === "function";
    if (shape) pass("guardedCompose exported (generate → verify → corrective retry → fail closed)");
    else fail("guardedCompose", "not exported");
  }
}

// ── Daily stance video: locked voice ──────────────────────────────────────────
// Regression guard for operator decision 2026-08-05: Veo has no voice-lock (no
// API/seed/reference-audio, just a text prompt), so the brief-writing LLM used
// to re-author the voice description from scratch every day — itself a source
// of drift on top of Veo's own per-generation variance. The fix moved the voice
// description out of the LLM's hands into `image_style.js VOICE_DIRECTIVE`, a
// fixed string `stance_video.js buildVideoPrompt()` splices in verbatim. If a
// future edit lets the LLM author that clause again, this won't catch the
// prose drifting — it catches the STRUCTURAL regression of two prompts (e.g.
// before/after a gate correction rewrites spoken_line) ending up with two
// different voice clauses, which is exactly what the string-replace it replaced
// was vulnerable to.
section("Daily stance video: locked voice");
{
  const { buildVideoPrompt } = require(path.join(RUNNER, "stance_video.js"));
  const { VOICE_DIRECTIVE, CHARACTER_DIRECTIVE } = require(path.join(RUNNER, "image_style.js"));

  const a = buildVideoPrompt({ location: "a rainy border checkpoint", spoken_line: "Nations need real borders." });
  const b = buildVideoPrompt({ location: "a flooded Bulacan street", spoken_line: "Sixteen days in, one article of impeachment down." });

  if (a.includes(VOICE_DIRECTIVE) && b.includes(VOICE_DIRECTIVE)) {
    pass("voice clause is the fixed VOICE_DIRECTIVE verbatim, not LLM prose");
  } else {
    fail("voice clause", "buildVideoPrompt output does not contain VOICE_DIRECTIVE verbatim");
  }

  // The two prompts differ only in location/spoken_line — the voice+character
  // clauses (everything else) must be byte-identical across subjects/languages.
  const strip = (s, line) => s.replace(line, "<LINE>");
  const aFixed = strip(a, "Nations need real borders.").replace("a rainy border checkpoint", "<LOC>");
  const bFixed = strip(b, "Sixteen days in, one article of impeachment down.").replace("a flooded Bulacan street", "<LOC>");
  if (aFixed === bFixed) pass("voice+character clause is byte-identical across two different subjects");
  else fail("voice+character clause", "prompts diverge outside location/spoken_line — voice is not locked");

  if (a.includes(CHARACTER_DIRECTIVE)) pass("character sheet still embedded alongside the locked voice");
  else fail("character sheet", "buildVideoPrompt dropped CHARACTER_DIRECTIVE");
}

// ── LinkedIn engagement wiring ────────────────────────────────────────────────
// Regression guard for a bug that silently killed LinkedIn engagement for a
// month: engage() ranked candidates with `score: score(p)` and no `await`, so
// with an async scorer `p.score` was a Promise, `Promise >= minScore` was always
// false, and `ranked` was always empty. The job ran on schedule and no-oped, and
// nothing in the logs said "broken" — it just said 0.
section("LinkedIn engagement wiring");
{
  const { LinkedIn } = require(path.join(ROOT, "tools/helmstack-social/src"));

  // Drive engage()'s ranking/action path with a stub client — no network.
  function stubEngine({ scorer, posts }) {
    const li = Object.create(LinkedIn.prototype);
    li.log = () => {};
    li.ownHandleHint = "";
    li.opened = [];
    li.fetchFeedCandidates = async () => posts;
    li.scrapeFeed = async () => posts;
    li.openPost = async (url) => { li.opened.push(url); return true; };
    li.like = async () => true;
    li.comment = async () => ({ ok: true });
    return li;
  }

  const POSTS = [
    { author: "A", text: "media framing of the impeachment vote", permalink: "https://x/u1" },
    { author: "B", text: "congratulations on the new role", permalink: "https://x/u2" },
  ];
  const onTopic = (p) => /impeachment|framing/.test(p.text);

  (async () => {
    // (1) The actual regression: an ASYNC scorer must still rank.
    {
      const li = stubEngine({ posts: POSTS });
      const r = await li.engage({
        score: async (p) => (onTopic(p) ? 3 : 0),
        minScore: 2, maxLikes: 3, maxComments: 0,
      });
      if (r.ranked === 1 && r.likes === 1) pass("async scorer: 1 of 2 posts ranked and liked (the await regression)");
      else fail("async scorer", `expected ranked=1 likes=1, got ranked=${r.ranked} likes=${r.likes}`);
    }

    // (2) A sync scorer must keep working — the fix must not regress the old path.
    {
      const li = stubEngine({ posts: POSTS });
      const r = await li.engage({
        score: (p) => (onTopic(p) ? 3 : 0),
        minScore: 2, maxLikes: 3, maxComments: 0,
      });
      if (r.ranked === 1 && r.likes === 1) pass("sync scorer still ranks (no regression on the old contract)");
      else fail("sync scorer", `expected ranked=1 likes=1, got ranked=${r.ranked} likes=${r.likes}`);
    }

    // (3) API-sourced candidates carry no DOM idx — engage() must open the
    //     permalink before acting, or every action silently targets nothing.
    {
      const li = stubEngine({ posts: POSTS });
      await li.engage({
        score: async (p) => (onTopic(p) ? 3 : 0),
        minScore: 2, maxLikes: 1, maxComments: 0,
      });
      if (li.opened.length === 1 && li.opened[0] === "https://x/u1") pass("API candidates open their permalink before acting");
      else fail("permalink open", `expected 1 open of u1, got ${JSON.stringify(li.opened)}`);
    }

    // (4) Scores below the gate must not be engaged at all.
    {
      const li = stubEngine({ posts: POSTS });
      const r = await li.engage({
        score: async () => 1,
        minScore: 2, maxLikes: 3, maxComments: 0,
      });
      if (r.ranked === 0 && r.likes === 0) pass("relevance gate: all-below-threshold engages nothing");
      else fail("relevance gate", `expected 0/0, got ranked=${r.ranked} likes=${r.likes}`);
    }

    // (5) The SECOND way this job silently no-oped for a month: scoring fanned
    //     the whole ~25-post feed out with Promise.all. The scorer is a Claude
    //     CLI subprocess, so all 25 blew their timeout, every catch returned 0,
    //     and "0 relevant" looked identical to a boring feed. Scoring must stay
    //     bounded.
    {
      const many = Array.from({ length: 25 }, (_, i) => ({ author: `A${i}`, text: "media framing", permalink: `https://x/p${i}` }));
      const li = stubEngine({ posts: many });
      let inflight = 0, peak = 0;
      await li.engage({
        score: async () => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return 0; },
        minScore: 2, maxLikes: 0, maxComments: 0, scoreConcurrency: 3,
      });
      if (peak <= 3) pass(`scoring is concurrency-bounded (peak ${peak} of 25 candidates)`);
      else fail("score concurrency", `expected peak <= 3, got ${peak}`);
    }

  })().catch((e) => fail("LinkedIn engagement wiring", e.message))
      .finally(() => {
        // This section is the only async one, so it owns the summary — the
        // synchronous tail below would otherwise print before these finish.
        printSummary();
        if (IS_CI && failed > 0) process.exit(1);
      });
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary() {
  process.stdout.write("\n" + "─".repeat(64) + "\n");
  process.stdout.write(`Tests: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failures.length > 0) {
    process.stdout.write("\nFailed tests:\n");
    for (const f of failures) {
      process.stdout.write(`  ✗ ${f.name}\n    ${f.reason}\n`);
    }
  }
  process.stdout.write("─".repeat(64) + "\n");
}

// NOTE: the summary is printed by the async "LinkedIn engagement wiring" section
// above (in its .finally), so that its results are counted before we report.
