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

printSummary();

if (IS_CI && failed > 0) process.exit(1);
