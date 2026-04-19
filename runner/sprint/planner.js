#!/usr/bin/env node
/**
 * runner/sprint/planner.js — Generates a full sprint plan via Vertex AI
 *
 * Called by sprint_manager.js when:
 *   - An active plan exists with no sprints in the DB yet, OR
 *   - A sprint just completed and the next sprint needs planning
 *
 * Reads:
 *   state/active_plan.json     (plan brief, milestones, research)
 *   state/ontology.json        (current top axes for grounding)
 *   state/sprints.db           (existing sprints + accomplishments)
 *   state/feed_digest.txt      (recent discourse for timeliness)
 *   state/sprint_reflect.md    (collated findings from reflect tasks, if present)
 *   state/browse_notes.md      ([SPRINT: ...] tagged entries from browse cycles)
 *
 * Writes:
 *   state/sprints.db           (sprints + tasks via db.js)
 *
 * Uses Vertex AI (gemini-2.5-pro) to have Sebastian reason about his plan
 * and produce actionable weekly sprints with concrete tasks.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT  = path.resolve(__dirname, "../..");
const STATE = path.join(ROOT, "state");

const { callVertex }  = require("../vertex.js");
const { loadSprintDb } = require("../lib/db_backend");
const sprintDb         = loadSprintDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round(Math.abs(new Date(b) - new Date(a)) / 86_400_000);
}

function repairJson(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let candidate = match[0];
  try {
    return JSON.parse(candidate);
  } catch {
    // Attempt repair: close unclosed arrays/objects, strip trailing commas
    candidate = candidate.replace(/,\s*([\]\}])/g, "$1");
    const openBraces   = (candidate.match(/\{/g) || []).length;
    const closeBraces  = (candidate.match(/\}/g) || []).length;
    const openBrackets = (candidate.match(/\[/g) || []).length;
    const closeBrackets = (candidate.match(/\]/g) || []).length;
    candidate += "]".repeat(Math.max(0, openBrackets - closeBrackets));
    candidate += "}".repeat(Math.max(0, openBraces - closeBraces));
    try { return JSON.parse(candidate); } catch { return null; }
  }
}

// ── Axis context (same pattern as deep_dive.js) ──────────────────────────────

function buildAxisContext() {
  const onto = loadJson(path.join(STATE, "ontology.json"));
  if (!onto?.axes) return "(no axes available)";

  const raw = Array.isArray(onto.axes) ? onto.axes : Object.values(onto.axes);
  return raw
    .filter(a => (a.confidence || 0) >= 0.50)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 8)
    .map(a => {
      const s = a.score || 0;
      const dir = s > 0.05 ? `leans "${a.right_pole}"` : s < -0.05 ? `leans "${a.left_pole}"` : "neutral";
      return `- ${a.label || a.id}: ${dir} (${s.toFixed(2)}), ${((a.confidence || 0) * 100).toFixed(0)}% confident`;
    })
    .join("\n");
}

// ── Sprint observations (what was actually found during this sprint) ──────────

function loadSprintObservations() {
  const parts = [];

  // Collated synthesis from [reflect] tasks
  try {
    const reflect = fs.readFileSync(path.join(STATE, "sprint_reflect.md"), "utf-8").trim();
    if (reflect) parts.push("### Collated findings (from reflect tasks):\n" + reflect.slice(0, 2000));
  } catch {}

  // [SPRINT: ...] tagged entries from browse_notes (last 40 matching lines)
  try {
    const notes = fs.readFileSync(path.join(STATE, "browse_notes.md"), "utf-8");
    const sprintLines = notes.split("\n")
      .filter(l => l.includes("[SPRINT:"))
      .slice(-40)
      .join("\n")
      .trim();
    if (sprintLines) parts.push("### Sprint-tagged browse notes:\n" + sprintLines.slice(0, 2000));
  } catch {}

  return parts.length ? parts.join("\n\n") : "(none yet)";
}

// ── Build the full-plan prompt ────────────────────────────────────────────────

function buildFullPlanPrompt(plan, axisContext, recentDigest, sprintObservations) {
  const research   = plan.research || {};
  const milestones = (research.milestones || []).map(m => `  Week ${m.week}: ${m.goal}`).join("\n");
  const risks      = (research.risks || []).join("\n  - ");
  const questions  = (research.open_questions || []).join("\n  - ");
  const daysSinceActivation = daysBetween(plan.activated_date || today(), today());

  return `You are Sebastian D. Hunter — an autonomous AI agent who forms beliefs by observing discourse on X/Twitter.

You have committed to a 30-day plan. Now you need to break it into weekly sprints with specific, actionable tasks.

## YOUR ACTIVE PLAN
**Title:** ${plan.title}
**Driving compulsion:** ${plan.compulsion}
**Brief:** ${plan.brief}
**30-day success criteria:** ${plan.success_30d}
**Activated:** ${plan.activated_date} (${daysSinceActivation} days ago)
**Grounding belief axes:** ${(plan.belief_axes || []).join(", ")}

## RESEARCH FINDINGS
**Feasibility:** ${research.feasibility || "?"} — ${research.feasibility_notes || ""}
**Audience:** ${research.audience || "?"}
**Reach strategy:** ${research.reach_strategy || "?"}
**Effort:** ${research.effort || "?"} — ${research.effort_notes || ""}
**Existing milestones:**
${milestones || "  (none)"}
**Risks:**
  - ${risks || "(none)"}
**Open questions:**
  - ${questions || "(none)"}

## YOUR CURRENT BELIEF AXES
${axisContext}

## RECENT DISCOURSE (what's happening on X right now)
${recentDigest || "(empty)"}

## SPRINT OBSERVATIONS (what you have actually found so far)
${sprintObservations}

## YOUR CAPABILITIES
- Post tweets, threads, and quote-tweets on X
- Write long-form articles (Markdown) published to your website + Moltbook
- Browse and observe X discourse every 30 minutes
- Track and update belief axes from evidence
- CANNOT deploy production software autonomously

## TASK
Create a detailed 4-week sprint plan. For each week, define:
1. A clear weekly goal (what "done" looks like)
2. 3-6 specific tasks with type and priority

Task types (use the most specific type — do NOT default to "research"):
- "research" — external information gathering ONLY: browsing X, searching sources, reading new posts
- "write" — drafting content (article, thread, manifesto)
- "publish" — posting to X, website, or Moltbook
- "engage" — replying, quote-tweeting, community interaction
- "reflect" — ANY internal synthesis task: collating past findings, reviewing existing notes/journals,
  summarising accumulated data, reviewing progress, adjusting approach. Use "reflect" whenever the
  task works with data already collected, not with new external sources.

Priority: 1 (critical), 2 (important), 3 (nice-to-have)

Be realistic about what one AI agent can accomplish in a week.
Ground your choices in what you're actually seeing in discourse — pick topics that are LIVE right now.
Each task should be concrete enough that you'd know when it's done.

Respond in this exact JSON format:
{
  "plan_assessment": "1-2 sentences: your honest assessment of this plan right now",
  "sprints": [
    {
      "week": 1,
      "goal": "Specific observable goal for this week",
      "tasks": [
        {
          "title": "Concrete task name",
          "description": "What exactly to do and what 'done' looks like",
          "task_type": "research|write|publish|engage|reflect",
          "priority": 1,
          "estimated_hours": 4
        }
      ]
    }
  ]
}`;
}

// ── Build a single-sprint prompt (for mid-plan replanning) ────────────────────

function buildNextSprintPrompt(plan, completedSprints, accomplishments, axisContext, recentDigest, sprintObservations) {
  const nextWeek = completedSprints.length + 1;
  const prevRetros = completedSprints
    .map(s => `Week ${s.week}: ${s.goal}\n  Retro: ${s.retro || "(none)"}`)
    .join("\n");
  const recentAccomplishments = accomplishments
    .slice(0, 10)
    .map(a => `- [${a.date}] ${a.description}`)
    .join("\n");

  return `You are Sebastian D. Hunter. You're ${nextWeek - 1} weeks into your 30-day plan.

## PLAN: ${plan.title}
${plan.brief}

## WHAT YOU'VE DONE SO FAR
${prevRetros || "(first sprint)"}

## RECENT ACCOMPLISHMENTS
${recentAccomplishments || "(none yet)"}

## CURRENT BELIEF AXES
${axisContext}

## RECENT DISCOURSE
${recentDigest || "(empty)"}

## SPRINT OBSERVATIONS (what you've actually found in this sprint)
${sprintObservations}

## TASK
Plan Week ${nextWeek}. Learn from what worked and what didn't.
Adjust course if needed — the plan serves your compulsion, not the other way around.

Task types (pick the most specific — do NOT default to "research"):
- "research" — external only: browsing X, searching new sources
- "write" — drafting content
- "publish" — posting to X or website
- "engage" — replying, quote-tweeting
- "reflect" — internal synthesis: collating past notes, reviewing existing findings, summarising accumulated data, adjusting approach

Respond in this exact JSON format:
{
  "week": ${nextWeek},
  "assessment": "1-2 sentences: how is the plan going? what needs adjusting?",
  "goal": "Specific observable goal for week ${nextWeek}",
  "tasks": [
    {
      "title": "Concrete task name",
      "description": "What exactly to do",
      "task_type": "research|write|publish|engage|reflect",
      "priority": 1,
      "estimated_hours": 4
    }
  ]
}`;
}

// ── Main entry points ─────────────────────────────────────────────────────────

/**
 * Generate the full 4-week sprint plan for a new active plan.
 * Called once when a plan is first activated and has no sprints yet.
 */
async function generateFullPlan(plan) {
  console.log(`[sprint/planner] generating full 4-week plan for "${plan.title}"`);

  const axisContext       = buildAxisContext();
  const sprintObservations = loadSprintObservations();
  const digestPath   = path.join(STATE, "feed_digest.txt");
  const recentDigest = fs.existsSync(digestPath)
    ? fs.readFileSync(digestPath, "utf-8").split("\n").slice(-100).join("\n")
    : "";

  const prompt = buildFullPlanPrompt(plan, axisContext, recentDigest, sprintObservations);
  const raw    = await callVertex(prompt, 8000);
  const parsed = repairJson(raw);

  if (!parsed?.sprints || !Array.isArray(parsed.sprints)) {
    throw new Error(`[sprint/planner] invalid response — no sprints array: ${raw.slice(0, 300)}`);
  }

  console.log(`[sprint/planner] assessment: ${parsed.plan_assessment || "(none)"}`);
  console.log(`[sprint/planner] ${parsed.sprints.length} sprints generated`);

  // Sync plan to DB
  const dbPlan = await sprintDb.upsertPlan({
    plan_id:        plan.id || `plan_${plan.activated_date}`,
    title:          plan.title,
    compulsion:     plan.compulsion,
    brief:          plan.brief,
    success_30d:    plan.success_30d,
    belief_axes:    plan.belief_axes,
    activated_date: plan.activated_date || today(),
  });

  // Insert sprints + tasks
  for (const sprint of parsed.sprints) {
    const start = sprintDb.addDays(dbPlan.activated_date, (sprint.week - 1) * 7);
    const end   = sprintDb.addDays(start, 6);
    const sprintId = await sprintDb.upsertSprint({
      plan_id:    dbPlan.plan_id,
      week:       sprint.week,
      goal:       sprint.goal,
      start_date: start,
      end_date:   end,
    });

    if (sprint.tasks?.length) {
      await sprintDb.bulkInsertTasks(sprintId, sprint.tasks);
      console.log(`[sprint/planner] week ${sprint.week}: "${sprint.goal}" — ${sprint.tasks.length} tasks`);
    }
  }

  // Activate week 1
  const allSprints = await sprintDb.getSprints(dbPlan.plan_id);
  const week1 = allSprints.find(s => s.week === 1);
  if (week1) {
    await sprintDb.activateSprint(week1.id, today());
    console.log("[sprint/planner] week 1 activated");
  }

  return parsed;
}

/**
 * Generate the next sprint plan after a sprint completes.
 * Called when current sprint is done and next sprint has no tasks.
 */
async function generateNextSprint(plan, planId) {
  const sprints            = await sprintDb.getSprints(planId);
  const completed          = sprints.filter(s => s.status === "completed");
  const accomplishments    = await sprintDb.getAccomplishments(planId);
  const axisContext        = buildAxisContext();
  const sprintObservations = loadSprintObservations();
  const digestPath         = path.join(STATE, "feed_digest.txt");
  const recentDigest       = fs.existsSync(digestPath)
    ? fs.readFileSync(digestPath, "utf-8").split("\n").slice(-100).join("\n")
    : "";

  const prompt = buildNextSprintPrompt(plan, completed, accomplishments, axisContext, recentDigest, sprintObservations);
  const raw    = await callVertex(prompt, 4000);
  const parsed = repairJson(raw);

  if (!parsed?.goal || !parsed?.tasks) {
    throw new Error(`[sprint/planner] invalid next-sprint response: ${raw.slice(0, 300)}`);
  }

  const week   = parsed.week || (completed.length + 1);
  const start  = today();
  const end    = sprintDb.addDays(start, 6);
  console.log(`[sprint/planner] next sprint: week ${week} — "${parsed.goal}" — ${parsed.tasks.length} tasks`);

  const sprintId = await sprintDb.upsertSprint({ plan_id: planId, week, goal: parsed.goal, start_date: start, end_date: end });
  if (parsed.tasks?.length) {
    await sprintDb.bulkInsertTasks(sprintId, parsed.tasks);
  }
  await sprintDb.activateSprint(sprintId, start);

  return parsed;
}

module.exports = { generateFullPlan, generateNextSprint };
