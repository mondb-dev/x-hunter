#!/usr/bin/env node
/**
 * runner/generate_checkpoint.js — produce checkpoints/checkpoint_N.md every 3 days
 *
 * Reads:  state/checkpoint_state.json (tracking last checkpoint date + count)
 *         state/ontology.json, state/belief_state.json
 *         daily/belief_report_*.md (last 3 available)
 * Writes: checkpoints/checkpoint_N.md
 *         checkpoints/latest.md (always overwritten with the same content)
 *         state/checkpoint_state.json (updated)
 *
 * Called daily from run.sh. Skips if fewer than 3 days have elapsed since last checkpoint.
 * Non-fatal: exits 0 on any error after logging.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT             = path.resolve(__dirname, "..");
const CHECKPOINTS_DIR  = path.join(ROOT, "checkpoints");
const DAILY_DIR        = path.join(ROOT, "daily");
const ONTO             = path.join(ROOT, "state", "ontology.json");
const BELIEF           = path.join(ROOT, "state", "belief_state.json");
const CHECKPOINT_STATE = path.join(ROOT, "state", "checkpoint_state.json");
const SNAPSHOTS_DIR    = path.join(ROOT, "state", "snapshots");
const SIGNAL_LOG       = path.join(ROOT, "state", "signal_log.jsonl");
const VOCATION_PATH    = path.join(ROOT, "state", "vocation.json");

const CHECKPOINT_INTERVAL_DAYS = 3;

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// Load env
if (require("fs").existsSync(path.join(ROOT, ".env"))) {
  for (const line of require("fs").readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function daysBetween(dateA, dateB) {
  const msA = new Date(dateA).getTime();
  const msB = new Date(dateB).getTime();
  return Math.round(Math.abs(msB - msA) / 86_400_000);
}

const { callVertex } = require("./vertex.js");
async function callLLM(prompt) { return callVertex(prompt, 4096); }

// ── Snapshot trajectory helpers ──────────────────────────────────────────────

/**
 * Load snapshots from the checkpoint period (last N days, default 3).
 * Returns array sorted oldest-first.
 */
function loadRecentSnapshots(days) {
  const snaps = [];
  if (!fs.existsSync(SNAPSHOTS_DIR)) return snaps;
  const files = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-(days + 1)); // +1 so we can compute velocity from the day before the window
  for (const f of files) {
    try {
      snaps.push(JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf-8')));
    } catch {}
  }
  return snaps;
}

/**
 * Build trajectory markdown: per-axis score/confidence change over snapshot window.
 */
function buildTrajectorySection(snapshots) {
  if (snapshots.length < 2) return null;

  const oldest = snapshots[0];
  const newest = snapshots[snapshots.length - 1];

  // Build lookup: axisId → { oldScore, newScore, oldConf, newConf }
  const oldMap = {};
  for (const a of (oldest.axes || [])) oldMap[a.id] = a;

  const rows = [];
  for (const a of (newest.axes || [])) {
    const old = oldMap[a.id];
    if (!old) continue;
    const dScore = (a.score - old.score);
    const dConf  = (a.confidence - old.confidence);
    if (Math.abs(dScore) < 0.001 && Math.abs(dConf) < 0.005) continue; // skip unchanged
    const arrow = dScore > 0.005 ? '↑' : dScore < -0.005 ? '↓' : '→';
    rows.push({
      label: a.label || a.id,
      arrow,
      dScore,
      dConf,
      score: a.score,
      conf: a.confidence,
      ev24: a.evidence_24h || 0,
    });
  }

  if (!rows.length) return null;

  rows.sort((a, b) => Math.abs(b.dScore) - Math.abs(a.dScore));

  let md = `### Axis trajectories (${oldest.date} → ${newest.date})\n\n`;
  md += `| Axis | Dir | Δ Score | Δ Confidence | Current Score | Evidence (24h) |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const r of rows.slice(0, 15)) {
    md += `| ${r.label} | ${r.arrow} | ${r.dScore >= 0 ? '+' : ''}${r.dScore.toFixed(3)} | ${r.dConf >= 0 ? '+' : ''}${(r.dConf * 100).toFixed(1)}% | ${r.score.toFixed(3)} | ${r.ev24} |\n`;
  }
  return md;
}

// ── Signal log helpers ───────────────────────────────────────────────────────

function loadSignalEvents(sinceDateStr) {
  const events = [];
  if (!fs.existsSync(SIGNAL_LOG)) return events;
  const cutoff = new Date(sinceDateStr).getTime();
  for (const line of fs.readFileSync(SIGNAL_LOG, 'utf-8').trim().split('\n')) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (new Date(ev.ts).getTime() >= cutoff) events.push(ev);
    } catch {}
  }
  return events;
}

function buildSignalSection(events) {
  if (!events.length) return null;
  let md = `### Cross-axis anomaly events\n\n`;
  for (const ev of events) {
    const axisLabels = (ev.axes || []).slice(0, 5).map(a => a.id).join(', ');
    md += `- **${ev.ts.slice(0, 16)}** — ${ev.strength} signal, ${ev.spike_count} axes (${axisLabels}${(ev.axes||[]).length > 5 ? ', …' : ''}), ${ev.evidence_24h} evidence entries\n`;
  }
  return md;
}

// ── Vocation helper ──────────────────────────────────────────────────────────

function buildVocationSection() {
  const voc = loadJson(VOCATION_PATH);
  if (!voc || voc.status === 'not_triggered') return null;
  let md = `### Vocation update\n\n`;
  md += `**Status:** ${voc.status}\n`;
  md += `**Label:** ${voc.label || '(forming)'}\n`;
  if (voc.description) md += `**Direction:** ${voc.description}\n`;
  if (voc.core_axes?.length) md += `**Core axes:** ${voc.core_axes.join(', ')}\n`;
  if (voc.intent) md += `**Intent:** ${voc.intent}\n`;
  return md;
}

(async function main() {
  try {
    // Load checkpoint state
    let cpState = loadJson(CHECKPOINT_STATE) || { last_checkpoint_date: null, checkpoint_count: 0 };

    // Check if enough days have elapsed
    if (cpState.last_checkpoint_date) {
      const elapsed = daysBetween(cpState.last_checkpoint_date, today);
      if (elapsed < CHECKPOINT_INTERVAL_DAYS) {
        console.log(
          `[checkpoint] ${elapsed} day(s) since last checkpoint — ` +
          `next in ${CHECKPOINT_INTERVAL_DAYS - elapsed} day(s), skipping`
        );
        return;
      }
    }

    // Gather recent daily reports (last 3)
    let recentReports = "";
    if (fs.existsSync(DAILY_DIR)) {
      const reportFiles = fs.readdirSync(DAILY_DIR)
        .filter(f => f.startsWith("belief_report_") && f.endsWith(".md"))
        .sort()
        .slice(-3);
      recentReports = reportFiles.map(f => {
        const raw = fs.readFileSync(path.join(DAILY_DIR, f), "utf-8");
        // Strip YAML frontmatter before embedding
        const content = raw.replace(/^---[\s\S]*?---\n/, "");
        // Extract just the summary sections (skip heavy full-ontology dump)
        const lines = content.split("\n");
        const summaryEnd = lines.findIndex((l, i) => i > 5 && l.startsWith("## Full ontology"));
        const snippet = lines.slice(0, summaryEnd > 0 ? summaryEnd : 30).join("\n").trim();
        return `### From ${f.replace("belief_report_", "").replace(".md", "")}\n\n${snippet}`;
      }).join("\n\n---\n\n");
    }

    // Load current belief state
    const onto   = loadJson(ONTO);
    const axes   = onto?.axes || [];
    const activeAxes = axes.filter(a => (a.confidence || 0) > 0.1);

    // Determine checkpoint number
    const n = (cpState.checkpoint_count || 0) + 1;

    if (!fs.existsSync(CHECKPOINTS_DIR)) fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

    // Build checkpoint content
    const highConf = activeAxes
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 5)
      .map(a => `- \`${a.id}\`: conf ${((a.confidence || 0) * 100).toFixed(0)}%, score ${(a.score || 0).toFixed(3)}`)
      .join("\n") || "- (none with confidence > 0.10 yet)";

    // Generate interpretation via Gemini (use ontology axes — they have labels/poles)
    let interpretation = "";
    try {
      const activeOntology = axes.filter(a => (a.confidence || 0) > 0.1)
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

      const axesContext = activeOntology
        .map(a => {
          const score = (a.score || 0);
          const lean = score > 0.05
            ? `leans toward "${a.right_pole || "right"}" (${score.toFixed(2)})`
            : score < -0.05
            ? `leans toward "${a.left_pole || "left"}" (${score.toFixed(2)})`
            : "roughly neutral";
          return `- ${a.label}: ${lean}, ${((a.confidence||0)*100).toFixed(0)}% confident, ${(a.evidence_log||[]).length} observations`;
        })
        .join("\n");

      const seedContext = axes.filter(a => (a.confidence || 0) <= 0.1)
        .map(a => `- ${a.label}`)
        .join("\n");

      const prompt = `You are writing an interpretation note for a public checkpoint of Sebastian D. Hunter's belief system.
Sebastian is an autonomous AI agent that browses X/Twitter daily and forms a genuine worldview through observation — no preset ideology.

Here are his active belief axes as of ${today}:

${axesContext || "(none with confidence > 10% yet)"}

Seeded axes still awaiting observations:
${seedContext || "(none)"}

Write 2–3 short paragraphs interpreting this snapshot in plain English. Cover:
1. What Sebastian believes most confidently right now, and what that reveals about his worldview
2. What tensions or through-lines exist across the axes
3. What is still forming — where the worldview is open and uncertain

Write in third person ("Sebastian..."). Be analytical, not promotional. Keep it concise — total 120–160 words. No bullet points. No headers. Plain paragraphs only.`;

      interpretation = await callLLM(prompt);
      console.log("[checkpoint] interpretation generated");
    } catch (err) {
      console.warn("[checkpoint] interpretation skipped:", err.message);
      interpretation = "_Interpretation not available for this checkpoint._";
    }

    // ── Trajectory + signal + vocation data ──────────────────────────────────
    const snapshots = loadRecentSnapshots(CHECKPOINT_INTERVAL_DAYS);
    const trajectoryMd = buildTrajectorySection(snapshots);

    const signalEvents = loadSignalEvents(cpState.last_checkpoint_date || '2020-01-01');
    const signalMd = buildSignalSection(signalEvents);

    const vocationMd = buildVocationSection();

    const allAxesSummary = axes.map(a => {
      const ev    = (a.evidence_log || []).length;
      const conf  = ((a.confidence || 0) * 100).toFixed(0);
      const score = (a.score || 0).toFixed(3);
      return `| ${a.label} | ${score} | ${conf}% | ${ev} |`;
    }).join("\n") || "| (none) | — | — | — |";

    const checkpoint = `---
date: "${today}"
title: "Checkpoint ${n} — ${today}"
checkpoint: ${n}
---

# Checkpoint ${n} — ${today}

**Generated:** ${new Date().toISOString()}
**Cycle:** Every ${CHECKPOINT_INTERVAL_DAYS} days
**Previous checkpoint:** ${cpState.last_checkpoint_date || "(none)"}

---

## Belief state summary

Total axes: **${axes.length}**
Axes with confidence > 10%: **${activeAxes.length}**

### Highest-confidence axes

${highConf}

---

## Interpretation

${interpretation}

---

${trajectoryMd ? `## Trajectory\n\n${trajectoryMd}\n\n---\n\n` : ''}${signalMd ? `## Anomaly log\n\n${signalMd}\n\n---\n\n` : ''}${vocationMd ? `## Vocation\n\n${vocationMd}\n\n---\n\n` : ''}## Full ontology at this checkpoint

| Axis label | Score | Confidence | Evidence entries |
|---|---|---|---|
${allAxesSummary}

---

## Recent daily reports

${recentReports || "(no daily reports yet)"}

---

*This checkpoint was auto-generated by generate_checkpoint.js.*
*Beliefs accumulate across all cycles — only the observation phase resets per cycle.*
`;

    const cpPath     = path.join(CHECKPOINTS_DIR, `checkpoint_${n}.md`);
    const latestPath = path.join(CHECKPOINTS_DIR, "latest.md");

    fs.writeFileSync(cpPath,     checkpoint, "utf-8");
    fs.writeFileSync(latestPath, checkpoint, "utf-8");

    // Update state
    cpState.last_checkpoint_date = today;
    cpState.checkpoint_count     = n;
    fs.writeFileSync(CHECKPOINT_STATE, JSON.stringify(cpState, null, 2), "utf-8");

    console.log(`[checkpoint] written: checkpoints/checkpoint_${n}.md + latest.md`);

    // ── Process reflection (§20.1) ───────────────────────────────────────
    // Ask Sebastian to reflect on process gaps and optionally produce a proposal.
    // Only if no active proposal already exists.
    const proposalPath = path.join(ROOT, "state", "process_proposal.json");
    let hasActiveProposal = false;
    try {
      const existing = JSON.parse(fs.readFileSync(proposalPath, "utf-8"));
      hasActiveProposal = ["pending", "building", "testing"].includes(existing.status);
    } catch {}

    if (!hasActiveProposal) {
      try {
        // Load proposal history for feedback loop
        let historyContext = "(no previous proposals)";
        try {
          const h = JSON.parse(fs.readFileSync(
            path.join(ROOT, "state", "proposal_history.json"), "utf-8"));
          const proposals = h.proposals || [];
          if (proposals.length > 0) {
            historyContext = proposals.slice(-5).map(p =>
              `- [${p.status}] "${p.title}" — ${p.resolution_notes || "no notes"}`
            ).join("\n");
          }
        } catch {}

        const reflectionPrompt = `You are Sebastian D. Hunter, an autonomous AI agent that browses X/Twitter and forms beliefs.
You are reflecting on your own process at Checkpoint ${n} (${today}).

Your current belief state:
${highConf || "(no active axes)"}

Recent daily reports (summarised):
${recentReports.slice(0, 3000) || "(none)"}

Previous process improvement proposals and their outcomes:
${historyContext}

REFLECTION TASK:
Where did your process fail or fall short in the last 3 days? What patterns kept emerging
that you had no framework for? What would you build to fix it?

Think about:
- Information you needed but could not get
- Patterns you noticed but had no way to track
- Processes that felt broken or incomplete
- Things you wanted to do but your pipeline didn't support

If you identify a SPECIFIC, actionable gap, output a JSON proposal block like this:

\`\`\`json
{
  "id": "proposal_<slug>_${Date.now()}",
  "status": "pending",
  "title": "Short description of what to build",
  "problem": "What gap or failure pattern you observed",
  "evidence": ["specific journal refs, dates, failure descriptions"],
  "proposed_solution": "What to build — conceptual, not code",
  "affected_files": ["best-guess list of files to modify or create"],
  "scope": "protocol|pipeline|prompt|state",
  "estimated_risk": "low|medium|high",
  "created_at": "${new Date().toISOString()}",
  "resolved_at": null,
  "resolution": null
}
\`\`\`

CONSTRAINTS:
- You CANNOT propose changes to: SOUL.md, IDENTITY.md, AGENTS.md §1-§11, orchestrator.js, lib/agent.js, lib/git.js, lib/state.js, .env, builder_pipeline.js, builder_vertex.js
- Maximum 1 proposal per checkpoint
- Must cite specific evidence (not vague feelings)
- If nothing genuinely needs fixing, say so — do not force a proposal

If no proposal is warranted, just write a brief reflection paragraph (no JSON block).`;

        const reflectionResult = await callLLM(reflectionPrompt);
        console.log("[checkpoint] process reflection completed");

        // Try to extract a proposal JSON from the response
        const jsonMatch = reflectionResult.match(/```json\s*\n([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            const proposal = JSON.parse(jsonMatch[1]);
            // Validate required fields + id format (prevents shell injection via branch names)
            if (proposal.id && proposal.title && proposal.problem && proposal.scope
                && /^proposal_[a-z0-9_]+$/i.test(proposal.id)) {
              proposal.status = "pending";
              proposal.created_at = new Date().toISOString();
              fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));
              console.log(`[checkpoint] process proposal written: ${proposal.title}`);
            } else {
              console.log("[checkpoint] proposal JSON missing required fields — skipped");
            }
          } catch (e) {
            console.log(`[checkpoint] could not parse proposal JSON: ${e.message}`);
          }
        } else {
          console.log("[checkpoint] no proposal in reflection (that's OK)");
        }
      } catch (err) {
        console.warn("[checkpoint] process reflection failed:", err.message);
      }
    } else {
      console.log("[checkpoint] active proposal exists — skipping reflection");
    }
  } catch (err) {
    console.error(`[checkpoint] failed: ${err.message}`);
    process.exit(0); // non-fatal
  }
})().catch(err => {
  console.error(`[checkpoint] fatal: ${err.message}`);
  process.exit(0);
});
