#!/usr/bin/env node
/**
 * runner/deep_dive.js — Research phase of the ponder pipeline
 *
 * Reads:  state/action_plans.json   (looks for "proposed" plans)
 *         state/ponder_state.json   (last_ponder_date, last_deep_dive_date)
 *         state/ontology.json       (for axis context in prompts)
 *
 * Writes: state/research_briefs.json  (research findings for top 2 proposed plans)
 *         state/ponder_state.json     (last_deep_dive_date)
 *
 * Trigger: proposed plans exist AND 1+ day since last_ponder_date
 *          AND last_deep_dive_date is null or predates last_ponder_date
 *
 * Picks the top 2 proposed plans (by position — ponder orders them by conviction strength).
 * Calls Vertex Pro for each: feasibility, audience, effort, 30-day milestones.
 * Does NOT mutate action_plans.json — decision.js reads research_briefs.json to decide.
 *
 * Called daily from run.sh after ponder.js. Non-fatal — exits 0 on any error.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT          = path.resolve(__dirname, "..");
const STATE         = path.join(ROOT, "state");
const PLANS_PATH    = path.join(STATE, "action_plans.json");
const PONDER_PATH   = path.join(STATE, "ponder_state.json");
const ONTO_PATH     = path.join(STATE, "ontology.json");
const BRIEFS_PATH   = path.join(STATE, "research_briefs.json");

const DEEP_DIVE_DELAY_DAYS = 1;
const TOP_N_PLANS          = 2;

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

function daysBetween(a, b) {
  return Math.round(Math.abs(new Date(b) - new Date(a)) / 86_400_000);
}

const { callVertex } = require("./vertex.js");

function buildAxisContext(onto) {
  const raw = onto?.axes
    ? (Array.isArray(onto.axes) ? onto.axes : Object.values(onto.axes))
    : Object.values(onto || {}).filter(v => typeof v === "object" && v !== null);

  return raw
    .filter(a => (a.confidence || 0) >= 0.72)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 6)
    .map(a => {
      const s = a.score || 0;
      const dir = s > 0.05
        ? `leans "${a.right_pole || "right"}" (${s.toFixed(2)})`
        : s < -0.05
        ? `leans "${a.left_pole || "left"}" (${s.toFixed(2)})`
        : "roughly neutral";
      return `- ${a.label || a.name || a.id}: ${dir}, ${((a.confidence || 0) * 100).toFixed(0)}% confident`;
    })
    .join("\n");
}

function buildResearchPrompt(plan, axisContext) {
  return `You are acting as a strategic research analyst for Sebastian D. Hunter — an autonomous AI agent that browses X/Twitter daily and forms genuine beliefs through direct observation.

Sebastian has proposed this action plan based on his strongest convictions:

**Plan title:** ${plan.title}
**Action type:** ${plan.action_type}
**Driving compulsion:** ${plan.compulsion}
**Brief:** ${plan.brief}
**Success in 30 days:** ${plan.success_30d}
**Grounding belief axes:** ${(plan.belief_axes || []).join(", ")}

${axisContext ? `**High-confidence belief axes (current state):**\n${axisContext}\n` : ""}

Research this plan for a solo AI agent who:
- Can write and post content on X (tweets, threads, quote-tweets)
- Can write long-form articles (Markdown) published to a website + Moltbook
- Has a growing but small X following (under 500 followers currently)
- Has genuine, evidence-backed convictions — not performance
- CANNOT autonomously deploy production software yet (builds = documented prototypes or spec docs)

Respond in this exact JSON format:
{
  "feasibility": "high|medium|low",
  "feasibility_notes": "...",
  "audience": "who specifically would care about this and why",
  "reach_strategy": "how to reach them given current small X following",
  "effort": "high|medium|low",
  "effort_notes": "realistic posts/work estimate per week",
  "milestones": [
    { "week": 1, "goal": "..." },
    { "week": 2, "goal": "..." },
    { "week": 4, "goal": "..." }
  ],
  "risks": ["risk 1", "risk 2", "risk 3"],
  "open_questions": ["question 1", "question 2"],
  "recommendation": "proceed|modify|park",
  "recommendation_reason": "...",
  "impact_score": 7,
  "feasibility_score": 6,
  "effort_score": 5
}

Be direct and realistic. Sebastian should act where conviction × feasibility is highest.`;
}

async function main() {
  console.log("[deep_dive] starting research phase check");

  const plans       = loadJson(PLANS_PATH) || [];
  const ponderState = loadJson(PONDER_PATH) || {};
  const onto        = loadJson(ONTO_PATH) || {};

  // Check trigger: must have proposed plans
  const proposed = plans.filter(p => p.status === "proposed");
  if (proposed.length === 0) {
    console.log("[deep_dive] no proposed plans — skipping");
    process.exit(0);
  }

  // Check trigger: must be 1+ day since last ponder
  const lastPonder = ponderState.last_ponder_date;
  if (!lastPonder) {
    console.log("[deep_dive] no ponder date recorded — skipping");
    process.exit(0);
  }

  const daysSincePonder = daysBetween(lastPonder, today());
  if (daysSincePonder < DEEP_DIVE_DELAY_DAYS) {
    console.log(`[deep_dive] ${daysSincePonder}d since ponder (need ${DEEP_DIVE_DELAY_DAYS}d) — skipping`);
    process.exit(0);
  }

  // Check trigger: only once per ponder session
  const lastDive = ponderState.last_deep_dive_date;
  if (lastDive && lastDive >= lastPonder) {
    console.log(`[deep_dive] already researched this ponder session (${lastDive}) — skipping`);
    process.exit(0);
  }

  // Pick top 2 plans (ponder orders them by conviction strength — take first N)
  const candidates = proposed.slice(0, TOP_N_PLANS);
  console.log(`[deep_dive] researching top ${candidates.length} of ${proposed.length} proposed plan(s) via Vertex Pro`);

  const axisContext = buildAxisContext(onto);
  const briefs = [];

  for (const plan of candidates) {
    console.log(`[deep_dive] researching: "${plan.title}"`);
    try {
      const prompt   = buildResearchPrompt(plan, axisContext);
      const raw      = await callVertex(prompt, 8000);
      // Extract JSON: try greedy match, then try repair for truncated JSON
      let research;
      const match    = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON in response");
      try {
        research = JSON.parse(match[0]);
      } catch (parseErr) {
        // Attempt repair: close any unclosed arrays/objects
        let candidate = match[0];
        // Truncate at last complete key-value (find last comma or closing bracket before error)
        const openBraces = (candidate.match(/\{/g) || []).length;
        const closeBraces = (candidate.match(/\}/g) || []).length;
        const openBrackets = (candidate.match(/\[/g) || []).length;
        const closeBrackets = (candidate.match(/\]/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) candidate += "]";
        for (let i = 0; i < openBraces - closeBraces; i++) candidate += "}";
        // Remove trailing comma before closing bracket
        candidate = candidate.replace(/,\s*([}\]])/g, "$1");
        research = JSON.parse(candidate);
        console.log(`[deep_dive] repaired truncated JSON for "${plan.title}"`);
      }

      briefs.push({
        plan_id:     plan.id,
        title:       plan.title,
        action_type: plan.action_type,
        compulsion:  plan.compulsion,
        brief:       plan.brief,
        belief_axes: plan.belief_axes || [],
        research,
      });

      console.log(`[deep_dive] "${plan.title}" → ${research.recommendation} | impact:${research.impact_score} feasibility:${research.feasibility_score} effort:${research.effort_score}`);
    } catch (err) {
      console.error(`[deep_dive] failed to research "${plan.title}": ${err.message}`);
    }
  }

  if (briefs.length === 0) {
    console.error("[deep_dive] all research calls failed — not writing briefs");
    process.exit(0);
  }

  saveJson(BRIEFS_PATH, {
    ponder_date:     lastPonder,
    researched_date: today(),
    briefs,
  });
  console.log(`[deep_dive] wrote ${briefs.length} brief(s) to state/research_briefs.json`);

  ponderState.last_deep_dive_date = today();
  saveJson(PONDER_PATH, ponderState);

  console.log("[deep_dive] done");
}

main().catch(err => {
  console.error("[deep_dive] error:", err.message);
  process.exit(0); // non-fatal
});
