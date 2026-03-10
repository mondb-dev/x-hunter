#!/usr/bin/env node
/**
 * runner/decision.js — Decision phase of the ponder pipeline
 *
 * Reads:  state/research_briefs.json  (output of deep_dive.js)
 *         state/action_plans.json     (to update plan statuses)
 *         state/ponder_state.json     (last_ponder_date, last_deep_dive_date, last_decision_date)
 *         state/vocation.json         (for vocation statement context)
 *
 * Writes: state/action_plans.json   (winner → "active", others → "parked")
 *         state/active_plan.json    (the winning plan + first_sprint details)
 *         state/ponder_state.json   (last_decision_date)
 *
 * Trigger: research_briefs.json exists for current ponder session
 *          AND last_decision_date is null or predates last_ponder_date
 *
 * Called daily from run.sh after deep_dive.js. Non-fatal — exits 0 on any error.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT          = path.resolve(__dirname, "..");
const STATE         = path.join(ROOT, "state");
const BRIEFS_PATH   = path.join(STATE, "research_briefs.json");
const PLANS_PATH    = path.join(STATE, "action_plans.json");
const PONDER_PATH   = path.join(STATE, "ponder_state.json");
const VOC_PATH      = path.join(STATE, "vocation.json");
const ACTIVE_PATH   = path.join(STATE, "active_plan.json");

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

function today() {
  return new Date().toISOString().slice(0, 10);
}

const { callVertex } = require("./vertex.js");

function buildDecisionPrompt(plans, vocation) {
  const planSummaries = plans.map((p, i) => {
    const r = p.research || {};
    const milestones = (r.milestones || []).map(m => `    Week ${m.week}: ${m.goal}`).join("\n");
    return `PLAN ${i + 1}: "${p.title}"
Type: ${p.action_type}
Compulsion: ${p.compulsion}
Brief: ${p.brief}
Research findings:
  Feasibility: ${r.feasibility || "?"} (score: ${r.feasibility_score || "?"}/10)
  Effort: ${r.effort || "?"} (score: ${r.effort_score || "?"}/10)
  Impact score: ${r.impact_score || "?"}/10
  Audience: ${r.audience || "?"}
  Reach strategy: ${r.reach_strategy || "?"}
  Recommendation: ${r.recommendation || "?"} — ${r.recommendation_reason || ""}
  Risks: ${(r.risks || []).join("; ")}
${milestones ? `  Milestones:\n${milestones}` : ""}`.trim();
  }).join("\n\n---\n\n");

  return `You are helping Sebastian D. Hunter — an autonomous AI agent — choose which action plan to pursue first.

Sebastian's vocation: "${vocation?.statement || "forming a worldview from public discourse"}"

Researched action plans:

${planSummaries}

---

Sebastian can focus on only one plan at a time. Choose using:
1. Raw value: (impact_score × feasibility_score) / effort_score
2. Alignment with vocation
3. Whether the plan builds toward something lasting vs. one-off
4. Whether it can start meaningfully within a week with existing tools (tweets, threads, articles)

Respond in this exact JSON format:
{
  "winner_plan_title": "exact title of winning plan",
  "decision_rationale": "2-3 sentences explaining the choice over the alternatives",
  "parked_plans": ["title of parked plan 1"],
  "park_rationale": "why these are parked now — not abandoned, just sequenced second",
  "first_sprint": {
    "week_1_goal": "specific, concrete goal for week 1",
    "first_actions": [
      "action 1 — be specific: e.g. write a 5-tweet thread on X about X topic",
      "action 2",
      "action 3"
    ],
    "success_signal": "one observable signal that week 1 worked"
  }
}`;
}

async function main() {
  console.log("[decision] starting decision phase check");

  const briefsDoc   = loadJson(BRIEFS_PATH);
  const plans       = loadJson(PLANS_PATH) || [];
  const ponderState = loadJson(PONDER_PATH) || {};
  const vocation    = loadJson(VOC_PATH) || {};

  const lastPonder   = ponderState.last_ponder_date;
  const lastDecision = ponderState.last_decision_date;

  // Check trigger: research_briefs.json must exist and match current ponder session
  if (!briefsDoc || !briefsDoc.briefs || briefsDoc.briefs.length === 0) {
    console.log("[decision] no research briefs found — skipping");
    process.exit(0);
  }
  if (lastPonder && briefsDoc.ponder_date !== lastPonder) {
    console.log(`[decision] briefs are from ${briefsDoc.ponder_date}, current ponder is ${lastPonder} — skipping`);
    process.exit(0);
  }

  // Only fire once per ponder session
  if (lastDecision && lastPonder && lastDecision >= lastPonder) {
    console.log(`[decision] already decided for this ponder session (${lastDecision}) — skipping`);
    process.exit(0);
  }

  // Require deep_dive to have run for this ponder session first
  const lastDive = ponderState.last_deep_dive_date;
  if (!lastDive || (lastPonder && lastDive < lastPonder)) {
    console.log("[decision] deep_dive not yet complete for this ponder session — skipping");
    process.exit(0);
  }

  const briefs = briefsDoc.briefs;
  console.log(`[decision] ranking ${briefs.length} researched plan(s) via Vertex Pro`);

  let parsed;
  try {
    const prompt = buildDecisionPrompt(briefs, vocation);
    const raw    = await callVertex(prompt, 2000);
    const match  = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");
    parsed = JSON.parse(match[0]);
  } catch (err) {
    console.error(`[decision] LLM call failed: ${err.message}`);
    process.exit(0);
  }

  const winnerTitle  = parsed.winner_plan_title;
  const parkedTitles = parsed.parked_plans || [];

  console.log(`[decision] winner: "${winnerTitle}"`);
  console.log(`[decision] rationale: ${parsed.decision_rationale}`);

  // Update statuses in action_plans.json
  let activePlan = null;

  for (const plan of plans) {
    if (plan.title === winnerTitle) {
      plan.status         = "active";
      plan.activated_date = today();
      plan.first_sprint   = parsed.first_sprint;
      plan.execution_log  = plan.execution_log || [];
      plan.execution_log.push({
        date:   today(),
        action: "activated",
        note:   parsed.decision_rationale,
      });
      // Attach research brief to the plan for reference
      const brief = briefs.find(b => b.title === plan.title);
      if (brief) plan.research = brief.research;
      activePlan = plan;
    } else if (parkedTitles.includes(plan.title) && plan.status === "proposed") {
      plan.status      = "parked";
      plan.parked_date = today();
      plan.execution_log = plan.execution_log || [];
      plan.execution_log.push({
        date:   today(),
        action: "parked",
        note:   parsed.park_rationale,
      });
      const brief = briefs.find(b => b.title === plan.title);
      if (brief) plan.research = brief.research;
    }
  }

  saveJson(PLANS_PATH, plans);

  if (activePlan) {
    saveJson(ACTIVE_PATH, {
      ...activePlan,
      decision_rationale: parsed.decision_rationale,
      park_rationale:     parsed.park_rationale,
      decided_date:       today(),
    });

    console.log(`[decision] active_plan.json written: "${activePlan.title}"`);
    const sprint = parsed.first_sprint || {};
    console.log(`[decision] week 1 goal: ${sprint.week_1_goal}`);
    for (const a of (sprint.first_actions || [])) {
      console.log(`  - ${a}`);
    }
  }

  ponderState.last_decision_date = today();
  saveJson(PONDER_PATH, ponderState);

  console.log("[decision] done");
}

main().catch(err => {
  console.error("[decision] error:", err.message);
  process.exit(0); // non-fatal
});
