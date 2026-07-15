#!/usr/bin/env node
/**
 * runner/helmstack_feedback.js — Sebastian's periodic dogfooding feedback on
 * HelmStack, so it can be built correctly.
 *
 * Sebastian is HelmStack's heaviest real user (posting, scraping, engagement,
 * profile automation across X/LinkedIn/FB). His logs are full of concrete
 * HelmStack friction — wedged tabs, composer insert misses, post-confirmed
 * false-negatives, profile-edit forms that don't render, timeouts. This scans
 * the recent logs, categorizes the failures with counts + verbatim examples,
 * and has Sebastian (via the Claude compose backend) write a prioritized
 * feedback note to <notes dir>/<date>.md (+ latest.md).
 *
 * Notes are LOCAL + gitignored (they're working notes for building HelmStack,
 * not repo content). Default dir: helmstack/notes/ (gitignored). Override with
 * HELMSTACK_NOTES_DIR to point elsewhere (e.g. the HelmStack project repo).
 *
 * Non-fatal. Wired into the orchestrator (dueForRun); also runnable by hand:
 *   node runner/helmstack_feedback.js [--dry]   (--dry = no LLM, deterministic report)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./lib/config");

const ROOT = config.PROJECT_ROOT || path.resolve(__dirname, "..");
const OUT_DIR = process.env.HELMSTACK_NOTES_DIR
  ? path.resolve(process.env.HELMSTACK_NOTES_DIR)
  : path.join(ROOT, "helmstack", "notes");
const DRY = process.argv.includes("--dry");
const TAIL = Number(process.env.HELMSTACK_FEEDBACK_TAIL || 4000);
const log = (m) => console.log(`[helmstack_feedback] ${m}`);

const LOGS = [
  "runner/runner.log",
  "runner/orchestrator.log",
  "runner/hunter-helmstack.log", // HelmStack app's own log — direct bugs
  "scraper/scraper.log",
].map((p) => path.join(ROOT, p));

const CATEGORIES = [
  { key: "tab_wedge", label: "Tabs wedge / navigation snaps back", re: /recycling wedged tab|did not land|wedged tab|no_modal_no_pending/i },
  { key: "composer_insert", label: "Composer insert unreliable (0-char miss / won't clear)", re: /text verify miss|composer would not clear|discarding draft|insert unverified|text_insert_failed/i },
  { key: "post_confirm_fn", label: "Post reported unconfirmed but actually posted (false negative)", re: /post_unconfirmed/i },
  { key: "profile_edit", label: "Profile-edit form not automatable (empty modal / missing field)", re: /bio_field_not_found|no_dialog|save_button_not_found/i },
  { key: "reachability", label: "HelmStack API/connection errors", re: /could not reach HelmStack|cannot reach HelmStack|Failed to parse URL|ECONNREFUSED|helmstack (GET|POST|DELETE)/i },
  { key: "selector_dom", label: "Selector/DOM element not found", re: /button_not_found|editor_not_found|no_follow_button|opener_not_found|no_connect_btn|no_top_connect|field_not_found/i },
  { key: "timeout", label: "Timeouts (incl. Network.enable)", re: /timed out|ETIMEDOUT|Network\.enable/i },
];

function scan() {
  const cats = CATEGORIES.map((c) => ({ ...c, count: 0, samples: [] }));
  const seen = new Set();
  for (const file of LOGS) {
    let lines = [];
    try { lines = fs.readFileSync(file, "utf-8").split("\n"); } catch { continue; }
    for (const line of lines.slice(-TAIL)) {
      if (!line.trim()) continue;
      for (const c of cats) {
        if (!c.re.test(line)) continue;
        c.count++;
        const clean = line.replace(/^\{.*?"ts":"[^"]*",?/, "").replace(/\s+/g, " ").trim().slice(0, 180);
        const key = clean.slice(0, 60);
        if (c.samples.length < 6 && !seen.has(key)) { c.samples.push(clean); seen.add(key); }
        break;
      }
    }
  }
  return cats.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
}

function deterministicReport(cats, date) {
  const lines = [`# HelmStack dogfooding feedback — ${date}`, "", `_Auto-generated from Sebastian's recent runtime logs (last ~${TAIL} lines/log)._`, ""];
  if (!cats.length) { lines.push("No HelmStack friction detected in the recent window. 🎉"); return lines.join("\n"); }
  lines.push("## Issues by frequency", "");
  for (const c of cats) {
    lines.push(`### ${c.label} — ${c.count} hit(s)`);
    for (const s of c.samples) lines.push(`- \`${s}\``);
    lines.push("");
  }
  return lines.join("\n");
}

async function composeReport(cats, date) {
  const { compose } = require("./lib/compose");
  const evidence = cats
    .map((c) => `## ${c.label}  (${c.count} occurrences)\n${c.samples.map((s) => `  - ${s}`).join("\n")}`)
    .join("\n\n");
  const prompt =
`You are Sebastian D. Hunter, an autonomous AI agent whose entire browser automation runs on HelmStack (a CDP-backed browser-substrate agent API). You are its heaviest real-world user — posting, scraping, and driving profile UIs across X, LinkedIn, and Facebook. Write a PERIODIC DOGFOODING FEEDBACK REPORT for the HelmStack developers so they can build it correctly.

Below is categorized evidence from your OWN recent runtime logs — real failures, with occurrence counts and verbatim log lines:

${evidence}

Write a concise, technical, PRIORITIZED report in Markdown. For each significant issue:
- name the failure and its user-facing impact (what it broke for you),
- cite the frequency and a verbatim example,
- give a concrete, specific suggestion for HelmStack — an API addition, a reliability fix, or a behavior change (e.g. "add a getBalance-style confirmed-post signal", "return isTrusted-click support for modal fields", "expose a per-tab 'settled' state").
Order by severity × frequency. Be direct and specific — this goes to the people who can fix it. Start with a one-paragraph summary. Do NOT invent issues not in the evidence. Output ONLY the Markdown report.`;
  return compose(prompt, { maxTokens: 1600, tag: "helmstack_feedback" });
}

(async () => {
  const date = new Date().toISOString().slice(0, 10);
  const cats = scan();
  log(`scanned ${LOGS.length} logs → ${cats.length} issue categor${cats.length === 1 ? "y" : "ies"} (${cats.reduce((n, c) => n + c.count, 0)} total hits)`);

  let report;
  if (DRY || !cats.length) {
    report = deterministicReport(cats, date);
  } else {
    try { report = (await composeReport(cats, date)).trim() || deterministicReport(cats, date); }
    catch (e) { log(`compose failed (${e.message}) — deterministic fallback`); report = deterministicReport(cats, date); }
    report = `# HelmStack dogfooding feedback — ${date}\n\n${report.replace(/^#\s+HelmStack[^\n]*\n+/i, "")}`;
  }

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${date}.md`), report + "\n");
    fs.writeFileSync(path.join(OUT_DIR, "latest.md"), report + "\n");
    log(`wrote ${path.relative(ROOT, OUT_DIR)}/${date}.md (+ latest.md)`);
  } catch (e) { log(`write failed: ${e.message}`); }
  process.exit(0);
})().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
