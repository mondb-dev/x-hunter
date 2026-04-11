#!/usr/bin/env node
/**
 * runner/generate_daily_report.js — produce daily/belief_report_YYYY-MM-DD.md
 *
 * Reads: state/ontology.json, state/snapshots/<yesterday>.json, journals/<today>_*.html
 * Writes: daily/belief_report_YYYY-MM-DD.md
 *
 * Includes delta narratives for axes that moved > 0.03 since yesterday,
 * with the top 3 evidence summaries driving the change.
 *
 * Called once per day from run.sh at the daily-maintenance trigger.
 * Non-fatal: exits 0 on any error after logging.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..");
const DAILY_DIR   = path.join(ROOT, "daily");
const ONTO        = path.join(ROOT, "state", "ontology.json");
const SNAPSHOTS   = path.join(ROOT, "state", "snapshots");
const JOURNALS    = path.join(ROOT, "journals");

const today     = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function todayJournalCount() {
  try {
    return fs.readdirSync(JOURNALS)
      .filter(f => f.startsWith(today) && f.endsWith(".html")).length;
  } catch { return 0; }
}

/** Top evidence entries added since yesterday (by timestamp), up to N. */
function recentEvidence(axis, n = 3) {
  const log = axis.evidence_log || [];
  const cutoff = yesterday + 'T00:00:00Z';
  return log
    .filter(e => (e.timestamp || '') >= cutoff)
    .slice(-n)
    .map(e => {
      const content = (e.content || e.summary || '').slice(0, 100).replace(/\n/g, ' ');
      const src = (e.source || '').replace(/https?:\/\/(x\.com|twitter\.com)\//, '@').slice(0, 60);
      return `${content}${src ? ` [${src}]` : ''}`;
    })
    .filter(Boolean);
}

(function main() {
  try {
    const onto = loadJson(ONTO);
    const axes = onto?.axes || [];

    // Load yesterday's snapshot for delta computation
    const prevSnap = loadJson(path.join(SNAPSHOTS, `${yesterday}.json`));
    const prevAxes = {};
    for (const ax of (prevSnap?.axes || [])) {
      prevAxes[ax.id] = { score: ax.score ?? 0, confidence: ax.confidence ?? 0 };
    }

    const journals = todayJournalCount();

    if (!fs.existsSync(DAILY_DIR)) fs.mkdirSync(DAILY_DIR, { recursive: true });

    const outPath = path.join(DAILY_DIR, `belief_report_${today}.md`);

    // Delta section: axes that moved > 0.03 or gained > 0.05 confidence
    const deltas = axes
      .map(ax => {
        const prev = prevAxes[ax.id];
        if (!prev) return null;
        const dScore = (ax.score ?? 0) - prev.score;
        const dConf  = (ax.confidence ?? 0) - prev.confidence;
        if (Math.abs(dScore) < 0.03 && Math.abs(dConf) < 0.05) return null;
        return { ax, dScore, dConf };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.dScore) - Math.abs(a.dScore))
      .slice(0, 10);

    let deltaSection = '';
    if (!prevSnap) {
      deltaSection = '_No yesterday snapshot available — delta narrative not yet generated._';
    } else if (deltas.length === 0) {
      deltaSection = '_No axes moved significantly since yesterday (all Δscore < 0.03)._';
    } else {
      deltaSection = deltas.map(({ ax, dScore, dConf }) => {
        const dir      = dScore >= 0 ? '▲' : '▼';
        const dScoreStr = (dScore >= 0 ? '+' : '') + dScore.toFixed(4);
        const dConfStr  = (dConf  >= 0 ? '+' : '') + (dConf * 100).toFixed(1) + '%';
        const evidence  = recentEvidence(ax);
        const evLines   = evidence.length
          ? '\n' + evidence.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
          : '';
        return [
          `### ${dir} ${ax.label}`,
          `- Score: ${dScoreStr} → now ${(ax.score ?? 0).toFixed(4)}`,
          `- Confidence: ${dConfStr} → now ${((ax.confidence ?? 0) * 100).toFixed(0)}%`,
          evidence.length ? `- Driven by:${evLines}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n');
    }

    // Full axes snapshot
    const axesLines = axes.map(ax => {
      const evidenceCount = (ax.evidence_log || []).length;
      const scoreBar      = scoreToBar(ax.score ?? 0);
      const confPct       = ((ax.confidence ?? 0) * 100).toFixed(0);
      const prev          = prevAxes[ax.id];
      const dScore        = prev ? ((ax.score ?? 0) - prev.score) : null;
      const delta         = dScore !== null
        ? ` (${dScore >= 0 ? '+' : ''}${dScore.toFixed(4)} today)`
        : '';
      return [
        `### ${ax.label}`,
        `- Score: ${(ax.score ?? 0).toFixed(4)}${delta}  ${scoreBar}`,
        `- Confidence: ${confPct}%`,
        `- Evidence entries: ${evidenceCount}`,
        `- Left pole: ${ax.left_pole || "(not set)"}`,
        `- Right pole: ${ax.right_pole || "(not set)"}`,
      ].join("\n");
    }).join("\n\n");

    const highConf = [...axes]
      .filter(a => (a.confidence || 0) > 0)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 3)
      .map(a => `- \`${a.id}\`: conf ${((a.confidence || 0) * 100).toFixed(0)}%, score ${(a.score || 0).toFixed(3)}`)
      .join("\n") || "- (none with confidence > 0 yet)";

    const report = `---
date: "${today}"
title: "Belief Report — ${today}"
---

# Belief Report — ${today}

**Generated:** ${new Date().toISOString()}
**Journals written today:** ${journals}
**Total axes tracked:** ${axes.length}

---

## Highest-confidence axes

${highConf}

---

## What moved today

${deltaSection}

---

## Full ontology snapshot

${axesLines || "(no axes yet)"}

---

*Auto-generated by generate_daily_report.js. Delta compares against ${yesterday} snapshot.*
`;

    fs.writeFileSync(outPath, report, "utf-8");
    console.log(`[daily_report] written: daily/belief_report_${today}.md (${axes.length} axes, ${deltas.length} moved)`);
  } catch (err) {
    console.error(`[daily_report] failed: ${err.message}`);
    process.exit(0); // non-fatal
  }
})();

/** Convert score [-1, +1] to a simple ASCII directional bar. */
function scoreToBar(score) {
  const pct    = Math.round((score + 1) / 2 * 10);
  const filled = Math.min(10, Math.max(0, pct));
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] (L${" ".repeat(10)}R)`;
}
