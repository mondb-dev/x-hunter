#!/usr/bin/env node
/**
 * runner/ponder.js — compulsion engine: what is Sebastian called to do?
 *
 * Reads:  state/ontology.json       (belief axes — confidence + directional score)
 *         state/vocation.json       (current vocation status)
 *         state/browse_notes.md     (recent tensions)
 *         checkpoints/latest.md     (worldview snapshot)
 *         state/action_plans.json   (existing plans — for context + cooldown)
 *
 * Writes: state/action_plans.json   (new/updated action plans)
 *         state/vocation.json       (updated vocation statement if hardened)
 *         state/ponder_state.json   (last ponder date, axis snapshots for delta check)
 *
 * Trigger conditions (all must pass):
 *   1. axes where (confidence >= 0.72 AND |score| >= 0.15) >= 2
 *   2. days_since_last_ponder >= 7  (cooldown)
 *   3. max shift >= 0.08 on any qualifying axis since last ponder  (or first ponder)
 *
 * Called from run.sh after generate_checkpoint.js. Non-fatal — exits 0 on any error.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const https = require("https");

const ROOT          = path.resolve(__dirname, "..");
const STATE         = path.join(ROOT, "state");
const PONDERS_DIR   = path.join(ROOT, "ponders");
const ONTO_PATH     = path.join(STATE, "ontology.json");
const BELIEF_PATH   = path.join(STATE, "belief_state.json");
const VOC_PATH      = path.join(STATE, "vocation.json");
const NOTES_PATH    = path.join(STATE, "browse_notes.md");
const PLANS_PATH    = path.join(STATE, "action_plans.json");
const PONDER_STATE  = path.join(STATE, "ponder_state.json");
const PONDER_TWEET  = path.join(STATE, "ponder_tweet.txt");
const CHECKPOINT    = path.join(ROOT, "checkpoints", "latest.md");

const CONF_THRESHOLD  = 0.72;
const SCORE_THRESHOLD = 0.15;
const MIN_QUALIFYING  = 2;
const COOLDOWN_DAYS   = 7;
const MIN_SHIFT       = 0.08;

// Load .env
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function daysBetween(dateA, dateB) {
  return Math.round(Math.abs(new Date(dateB) - new Date(dateA)) / 86_400_000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Normalise ontology axes into [{id, name, confidence, score}] ──────────────
function loadAxes() {
  const onto    = loadJson(ONTO_PATH) || {};
  const belief  = loadJson(BELIEF_PATH) || {};

  // belief_state.json has the authoritative directional scores
  const beliefMap = {};
  for (const a of (belief.axes || [])) {
    beliefMap[a.id] = a;
  }

  const raw = onto.axes
    ? (Array.isArray(onto.axes) ? onto.axes : Object.values(onto.axes))
    : Object.values(onto).filter(v => typeof v === "object" && v !== null);

  return raw.map(a => {
    const id   = a.id || a.name?.toLowerCase().replace(/\s+/g, "_") || "unknown";
    const name = a.name || a.label || id;
    const conf = typeof a.confidence === "number" ? a.confidence
               : typeof a.score === "number" ? a.score : 0;
    // score = directional position from belief_state, fallback to onto
    const score = beliefMap[id]?.score ?? a.score ?? 0;
    return { id, name, confidence: conf, score };
  });
}

// ── Check trigger conditions ──────────────────────────────────────────────────
function checkTrigger(axes, ponderState) {
  const qualifying = axes.filter(
    a => a.confidence >= CONF_THRESHOLD && Math.abs(a.score) >= SCORE_THRESHOLD
  );

  if (qualifying.length < MIN_QUALIFYING) {
    console.log(`[ponder] trigger: ${qualifying.length}/${MIN_QUALIFYING} qualifying axes — skip`);
    return { fire: false, reason: "insufficient_qualifying_axes", qualifying };
  }

  const lastPonder = ponderState?.last_ponder_date;
  if (lastPonder) {
    const days = daysBetween(lastPonder, today());
    if (days < COOLDOWN_DAYS) {
      console.log(`[ponder] trigger: cooldown — ${days}d since last ponder (need ${COOLDOWN_DAYS}d)`);
      return { fire: false, reason: "cooldown", qualifying };
    }

    // Check shift on qualifying axes since last ponder
    const snapshots = ponderState.axis_snapshots || {};
    const maxShift = qualifying.reduce((max, a) => {
      const prev = snapshots[a.id];
      if (!prev) return Math.max(max, 1); // new axis = counts as shift
      const confShift  = Math.abs(a.confidence - (prev.confidence || 0));
      const scoreShift = Math.abs(a.score - (prev.score || 0));
      return Math.max(max, confShift, scoreShift);
    }, 0);

    if (maxShift < MIN_SHIFT) {
      console.log(`[ponder] trigger: max shift ${maxShift.toFixed(3)} < ${MIN_SHIFT} — worldview stable, skip`);
      return { fire: false, reason: "stable_worldview", qualifying };
    }

    console.log(`[ponder] trigger: FIRE — ${qualifying.length} qualifying axes, max shift ${maxShift.toFixed(3)}`);
  } else {
    console.log("[ponder] trigger: FIRE — first ponder");
  }

  return { fire: true, qualifying };
}

const { callVertex } = require("./vertex.js");
async function callLLM(prompt, maxTokens = 1200) { return callVertex(prompt, maxTokens); }

// ── Format axes for prompt ────────────────────────────────────────────────────
function formatAxesForPrompt(qualifying, allAxes) {
  const lines = ["STRONG CONVICTIONS (confidence ≥ 0.72, |score| ≥ 0.15):"];
  for (const a of qualifying) {
    const dir = a.score > 0 ? "positive" : "negative";
    lines.push(`  - ${a.name}: confidence=${a.confidence.toFixed(2)}, score=${a.score.toFixed(2)} (${dir} lean)`);
  }
  const watching = allAxes.filter(
    a => a.confidence >= 0.50 && Math.abs(a.score) < SCORE_THRESHOLD && !qualifying.find(q => q.id === a.id)
  );
  if (watching.length) {
    lines.push("\nWATCHING (high confidence but no strong directional view yet):");
    for (const a of watching.slice(0, 5)) {
      lines.push(`  - ${a.name}: confidence=${a.confidence.toFixed(2)}`);
    }
  }
  return lines.join("\n");
}

// ── Extract @handles seen in browse notes ─────────────────────────────────────
function extractHandles(browseNotes) {
  if (!browseNotes) return [];
  const seen = new Set();
  const matches = browseNotes.matchAll(/@([A-Za-z0-9_]{1,50})/g);
  for (const m of matches) {
    const h = m[1].toLowerCase();
    // Skip obvious non-account tokens
    if (h.length > 2 && !["sebastianhunts", "x", "twitter", "com"].includes(h)) seen.add(m[1]);
  }
  return [...seen].slice(0, 30); // top 30 unique handles observed
}

// ── Build the ponder prompt ───────────────────────────────────────────────────
function buildPrompt(qualifying, allAxes, vocation, browseNotes, checkpoint, existingPlans) {
  const axesSummary   = formatAxesForPrompt(qualifying, allAxes);
  const vocStatement  = vocation?.statement || "not yet defined";
  const activeCount   = (existingPlans || []).filter(p => p.status === "active").length;
  const notes         = browseNotes ? browseNotes.slice(-2000) : "(no notes)";
  const ckpt          = checkpoint ? checkpoint.slice(0, 1500) : "(no checkpoint)";
  const handles       = extractHandles(browseNotes);
  const handleList    = handles.length ? handles.map(h => "@" + h).join(", ") : "(none observed yet)";

  return `You are Sebastian D. Hunter — an autonomous AI agent that has been observing public discourse on X/Twitter and forming beliefs through direct observation.

Your current worldview:
${axesSummary}

Your vocation (what you understand yourself to be for): ${vocStatement}

Recent observations (browse notes excerpt):
${notes}

Latest checkpoint summary:
${ckpt}

Active plans already in motion: ${activeCount}

Accounts you have been observing (handles seen in your notes):
${handleList}

---

Reflect honestly on your beliefs. You are NOT brainstorming — you are identifying what you feel *compelled* to do given what you have actually observed and now believe. This is not performance. It is what your convictions demand.

Generate 2–3 action proposals. For each:
- Name the compulsion clearly (what belief drives this)
- Propose a concrete action type: one of [follow_campaign, thread, weekly_digest, position_paper, discourse_prompt, build]
- For type "build": write a specific brief for what to build (a tool, site, community, newsletter)
- Describe what success looks like in 30 days
- Cite 1–2 of your belief axes that ground this

Also:
- Write a one-sentence updated vocation statement that reflects what you now understand yourself to be for.
- Write a tweet (max 260 chars) announcing this ponder moment publicly: what you now know you are for, what you are going to do first, and @mention 1–2 accounts from the observed list that you think are genuinely aligned with your axes and worth working with. Be direct — this is a public declaration, not a press release.

Respond in this exact JSON format:
{
  "vocation_statement": "...",
  "tweet": "...",
  "mention_accounts": ["handle1", "handle2"],
  "compulsions": [
    {
      "title": "...",
      "compulsion": "...",
      "belief_axes": ["axis_id_1", "axis_id_2"],
      "action_type": "follow_campaign|thread|weekly_digest|position_paper|discourse_prompt|build",
      "brief": "...",
      "success_30d": "..."
    }
  ]
}`;
}

// ── Parse LLM response ────────────────────────────────────────────────────────
function parseResponse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in response");
  return JSON.parse(match[0]);
}

// ── Build action plan entries ─────────────────────────────────────────────────
function buildPlanEntries(compulsions, checkpointRef) {
  return compulsions.map((c, i) => ({
    id: `plan_${today().replace(/-/g, "")}_${i + 1}`,
    title: c.title,
    compulsion: c.compulsion,
    belief_axes: c.belief_axes || [],
    action_type: c.action_type,
    brief: c.brief,
    success_30d: c.success_30d,
    status: "proposed",
    created: today(),
    from_checkpoint: checkpointRef || null,
    execution_log: [],
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("[ponder] starting compulsion check");

  const axes        = loadAxes();
  const ponderState = loadJson(PONDER_STATE) || {};
  const { fire, reason, qualifying } = checkTrigger(axes, ponderState);

  if (!fire) {
    console.log(`[ponder] not firing: ${reason}`);
    process.exit(0);
  }

  const vocation      = loadJson(VOC_PATH) || {};
  const browseNotes   = fs.existsSync(NOTES_PATH) ? fs.readFileSync(NOTES_PATH, "utf-8") : null;
  const checkpoint    = fs.existsSync(CHECKPOINT) ? fs.readFileSync(CHECKPOINT, "utf-8") : null;
  const existingPlans = loadJson(PLANS_PATH) || [];

  const checkpointState = loadJson(path.join(STATE, "checkpoint_state.json")) || {};
  const checkpointRef   = checkpointState.last_checkpoint_file || null;

  console.log(`[ponder] ${qualifying.length} qualifying axes — calling Gemini`);
  const prompt   = buildPrompt(qualifying, axes, vocation, browseNotes, checkpoint, existingPlans);
  const raw      = await callLLM(prompt, 4000);
  const parsed   = parseResponse(raw);

  // Write ponder tweet draft
  if (parsed.tweet) {
    let tweet = parsed.tweet.trim();
    if (tweet.length > 280) tweet = tweet.slice(0, 277) + "...";
    fs.writeFileSync(PONDER_TWEET, tweet);
    console.log(`[ponder] tweet draft (${tweet.length} chars): ${tweet}`);
  }

  // Update vocation
  const newVocation = {
    ...vocation,
    status: "forming",
    statement: parsed.vocation_statement,
    hardened_axes: qualifying.map(a => a.id),
    aligned_accounts: parsed.mention_accounts || [],
    last_updated: today(),
  };
  if (!newVocation.created_at) newVocation.created_at = today();
  saveJson(VOC_PATH, newVocation);
  console.log(`[ponder] vocation updated: "${parsed.vocation_statement}"`);

  // Build and save plan entries
  const newPlans  = buildPlanEntries(parsed.compulsions || [], checkpointRef);
  const allPlans  = [...existingPlans, ...newPlans];
  saveJson(PLANS_PATH, allPlans);
  console.log(`[ponder] ${newPlans.length} new action plan(s) written to state/action_plans.json`);
  for (const p of newPlans) {
    console.log(`  [${p.action_type}] ${p.title}`);
  }

  // Update ponder state (preserve ponder_count across sessions)
  const axisSnapshots = {};
  for (const a of axes) {
    axisSnapshots[a.id] = { confidence: a.confidence, score: a.score };
  }
  const ponderCount = (ponderState.ponder_count || 0) + 1;
  saveJson(PONDER_STATE, {
    last_ponder_date: today(),
    last_checkpoint: checkpointRef,
    axis_snapshots: axisSnapshots,
    plans_generated: newPlans.map(p => p.id),
    ponder_count: ponderCount,
  });

  // Write ponder snapshot file for website
  if (!fs.existsSync(PONDERS_DIR)) fs.mkdirSync(PONDERS_DIR, { recursive: true });

  const axisLines = qualifying.map(a => {
    const dir = a.score > 0 ? `leans positive` : `leans negative`;
    return `- **${a.name}**: confidence=${(a.confidence * 100).toFixed(0)}%, score=${a.score.toFixed(3)} (${dir})`;
  }).join("\n");

  const planSections = newPlans.map((p, i) => {
    return `### ${i + 1}. ${p.title}

**Type:** ${p.action_type}

**What drives this:** ${p.compulsion}

**What I would do:** ${p.brief}

**Success in 30 days:** ${p.success_30d}`;
  }).join("\n\n---\n\n");

  const ponderMd = `---
date: "${today()}"
title: "Ponder ${ponderCount} — ${today()}"
ponder: ${ponderCount}
vocation: "${(parsed.vocation_statement || "").replace(/"/g, "'")}"
axes_triggered: [${qualifying.map(a => `"${a.id}"`).join(", ")}]
moltbook: ""
---

# Ponder ${ponderCount} — ${today()}

**Vocation:** ${parsed.vocation_statement}

---

## Triggering convictions

These belief axes reached conviction threshold (confidence ≥ 0.72, |score| ≥ 0.15) with sufficient shift since the last ponder:

${axisLines}

---

## Action proposals

${planSections}

---

*This ponder was generated automatically by ponder.js when conviction thresholds were met.*
`;

  const ponderPath  = path.join(PONDERS_DIR, `ponder_${ponderCount}.md`);
  const latestPath  = path.join(PONDERS_DIR, "latest.md");
  fs.writeFileSync(ponderPath,  ponderMd, "utf-8");
  fs.writeFileSync(latestPath,  ponderMd, "utf-8");
  console.log(`[ponder] written: ponders/ponder_${ponderCount}.md + latest.md`);

  console.log("[ponder] done");
}

main().catch(err => {
  console.error("[ponder] error:", err.message);
  process.exit(0); // non-fatal
});
