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

// ── Sprint validation ────────────────────────────────────────────────────────

const PLACEHOLDER_ARTIFACTS = new Set(["", "(none)", "none", "n/a", "na", "null", "tbd", "todo"]);

function hasRealArtifact(t) {
  const a = String(t.artifact || t.output_ref || "").trim().toLowerCase();
  if (PLACEHOLDER_ARTIFACTS.has(a)) return false;
  // Reject prompt-template strings the LLM sometimes echoes back
  if (a.startsWith("or ") || a.includes("if no file output")) return false;
  return a.length > 0;
}

const OPEN_ENDED_TITLE_RE = /^\s*(identify|pick|select|choose|decide)\b/i;

function titleFingerprint(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/#?\d+/g, "")          // drop "Report #2" / "Week 3" numbering
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(w => w.length > 3)       // drop short words (a, the, of, for)
    .sort()                          // word-bag comparison
    .join(" ");
}

function validateSprintTasks(tasks, weekLabel) {
  const errors = [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    errors.push(`${weekLabel}: tasks array is empty or missing`);
    return errors;
  }

  const seenFingerprints = new Map();
  for (const t of tasks) {
    const title = String(t.title || "").trim();
    if (!title) {
      errors.push(`${weekLabel}: a task is missing a title`);
      continue;
    }

    if ((t.task_type === "write" || t.task_type === "publish") && !hasRealArtifact(t)) {
      errors.push(`${weekLabel}: "${title}" (${t.task_type}) is missing a concrete artifact path — every write/publish task must name a file path or URL pattern`);
    }

    if (OPEN_ENDED_TITLE_RE.test(title)) {
      errors.push(`${weekLabel}: "${title}" is an open-ended select task — rephrase as continuous observation tied to an artifact, e.g. "Curate week's polarization map" or merge into the write task`);
    }

    const fp = titleFingerprint(title);
    if (fp && seenFingerprints.has(fp)) {
      errors.push(`${weekLabel}: "${title}" duplicates the intent of "${seenFingerprints.get(fp)}" — merge them into one task`);
    } else if (fp) {
      seenFingerprints.set(fp, title);
    }
  }
  return errors;
}

function validatePlannerResponse(parsed) {
  if (!parsed) return ["response was not valid JSON"];
  const sprints = parsed.sprints || [{ week: parsed.week, tasks: parsed.tasks }];
  const errors = [];
  for (const s of sprints) {
    errors.push(...validateSprintTasks(s.tasks || [], `Week ${s.week ?? "?"}`));
  }
  return errors;
}

async function callPlannerWithRetry(basePrompt, maxTokens, label, maxAttempts = 3) {
  let lastErrors = [];
  let lastParsed = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let prompt = basePrompt;
    if (lastErrors.length) {
      prompt = basePrompt + `\n\n## YOUR PREVIOUS RESPONSE FAILED VALIDATION\nFix these specific issues and re-emit the same JSON shape:\n${lastErrors.map(e => "- " + e).join("\n")}\n\nRe-read the CRITICAL RULES section above. Do not repeat the same mistakes.`;
    }
    const raw = await callVertex(prompt, maxTokens);
    const parsed = repairJson(raw);
    const errors = validatePlannerResponse(parsed);
    if (errors.length === 0) {
      if (attempt > 1) console.log(`[sprint/planner] ${label} validated on attempt ${attempt}`);
      return parsed;
    }
    console.log(`[sprint/planner] ${label} attempt ${attempt} failed validation: ${errors.length} issue(s)`);
    for (const e of errors) console.log(`  - ${e}`);
    lastErrors = errors;
    lastParsed = parsed;
  }
  console.log(`[sprint/planner] ${label} still invalid after ${maxAttempts} attempts — accepting with warnings`);
  return lastParsed;
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
2. 3-6 specific tasks with type, priority, and (where applicable) a concrete artifact

Task types (use the most specific type — do NOT default to "research"):
- "research" — external information gathering ONLY: browsing X, searching sources, reading new posts
- "write" — drafting content (article, thread, manifesto)
- "publish" — posting to X, website, or Moltbook
- "engage" — replying, quote-tweeting, community interaction
- "reflect" — ANY internal synthesis task: collating past findings, reviewing existing notes/journals,
  summarising accumulated data, reviewing progress, adjusting approach. Use "reflect" whenever the
  task works with data already collected, not with new external sources.

Priority: 1 (critical), 2 (important), 3 (nice-to-have)

## CRITICAL RULES (read carefully — past plans have violated these)

**1. No open-ended "select" tasks.** Tasks like "Identify top topic for the week" or "Pick the best
candidate" have no closure criterion — the agent will keep researching forever. If the plan involves
a recurring publication, frame the week as a **digest of the period**, not a deep-dive on a single
chosen topic. Tasks become: continuous observation → end-of-week synthesis → publish artifact.
The "topic" of a digest is "this week" — that resolves automatically.

**2. Every "write" or "publish" task MUST name a concrete artifact.** Use the \`artifact\` field
with a deterministic file path or URL pattern. Examples:
- "articles/reports/Report_NN.md"
- "articles/YYYY-MM-DD.md"
- "x.com/<handle>/status/<id> (X thread)"
The publish task only closes when the artifact exists. If you can't name the artifact path, the task
is too vague — refine it.

**3. No duplicate tasks within a sprint.** Each task must be uniquely actionable. Do NOT generate
variants of the same task ("Draft Report" + "Draft & Publish Report" → pick one and merge).
Before emitting a sprint, check that no two tasks share the same intent.

**4. Goals must be measurable from data the system actually tracks.** "Reach 150 followers" is
fine ONLY if follower counts are being recorded. "Establish methodology" / "Refine approach" are
process goals, not deliverables — pair them with a concrete artifact (e.g., "methodology section
in articles/reports/Report_1.md").

**5. Be realistic.** One AI agent, one week. Ground choices in what's LIVE in discourse right now.

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
          "estimated_hours": 4,
          "artifact": "articles/reports/Report_1.md or null if no file output"
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

## CRITICAL RULES

**1. No open-ended "select" tasks.** Don't write "Identify top topic for Week ${nextWeek}" — that has
no closure criterion. If this plan involves a recurring publication, treat the week itself as the
"topic": continuous observation across the week → end-of-week synthesis → publish artifact.

**2. Every "write" / "publish" task MUST name a concrete artifact** in the \`artifact\` field
(e.g., "articles/reports/Report_${nextWeek}.md"). Without a file path, the task can't be verified done.

**3. No duplicate tasks.** Each task must be uniquely actionable. Don't emit "Draft Report" and
"Draft & Publish Report" as separate tasks — pick one.

**4. Goals must be testable from data the system tracks.** Pair process goals ("refine methodology")
with a concrete artifact section.

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
      "estimated_hours": 4,
      "artifact": "articles/reports/Report_${nextWeek}.md or null if no file output"
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
  const parsed = await callPlannerWithRetry(prompt, 8000, "full-plan");

  if (!parsed?.sprints || !Array.isArray(parsed.sprints)) {
    throw new Error(`[sprint/planner] invalid response — no sprints array after retries`);
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
  const parsed = await callPlannerWithRetry(prompt, 4000, `next-sprint week-${completed.length + 1}`);

  if (!parsed?.goal || !parsed?.tasks) {
    throw new Error(`[sprint/planner] invalid next-sprint response after retries`);
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
