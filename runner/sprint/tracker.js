#!/usr/bin/env node
/**
 * runner/sprint/tracker.js — Daily sprint progress tracker
 *
 * Called by sprint_manager.js each daily cycle.
 *
 * Responsibilities:
 *   1. Check if current sprint's dates have elapsed → auto-complete + retro
 *   2. Scan today's outputs (articles, posts, journals) for task completion signals
 *   3. Write a daily_log entry summarizing focus/progress
 *   4. Detect if all tasks in current sprint are done → trigger sprint completion
 *
 * Uses Vertex AI for:
 *   - Sprint retrospective (when a sprint completes)
 *   - Matching accomplishments to tasks (lightweight — 2000 tokens)
 *
 * All state flows through sprint/db.js. No direct JSON file mutations.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT  = path.resolve(__dirname, "../..");
const STATE = path.join(ROOT, "state");

const { callVertex } = require("../vertex.js");
const sprintDb       = require("./db.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
}

function repairJson(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let candidate = match[0];
  try {
    return JSON.parse(candidate);
  } catch {
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

// ── Scan for accomplishments ──────────────────────────────────────────────────

/**
 * Gather signals of what Sebastian did today — articles, posts, journals.
 * Returns an array of { source, description } objects.
 */
function gatherTodaySignals() {
  const d = today();
  const signals = [];

  // Check for articles written today
  const articlesDir = path.join(ROOT, "articles");
  if (fs.existsSync(articlesDir)) {
    const articleFile = path.join(articlesDir, `${d}.md`);
    if (fs.existsSync(articleFile)) {
      const content = fs.readFileSync(articleFile, "utf-8");
      const titleMatch = content.match(/^#\s+(.+)/m);
      signals.push({
        source: "article",
        description: `Published article: "${titleMatch?.[1] || "untitled"}"`,
      });
    }
  }

  // Check posts_log for today's posts
  const postsLog = loadJson(path.join(STATE, "posts_log.json"));
  if (postsLog?.posts) {
    const todayPosts = postsLog.posts.filter(p => p.date === d || p.posted_at?.startsWith(d));
    for (const p of todayPosts) {
      signals.push({
        source: `tweet:${p.type || "post"}`,
        description: `Posted ${p.type || "tweet"}: "${(p.content || "").slice(0, 100)}"`,
      });
    }
  }

  // Check for journal entries today
  const journalsDir = path.join(ROOT, "journals");
  if (fs.existsSync(journalsDir)) {
    const journalFiles = fs.readdirSync(journalsDir).filter(f => f.startsWith(d));
    if (journalFiles.length > 0) {
      signals.push({
        source: "journals",
        description: `Wrote ${journalFiles.length} journal entries`,
      });
    }
  }

  // Check for sprint_tweet_flag.txt (written by TWEET agent when choosing Option A)
  const sprintFlagPath = path.join(STATE, "sprint_tweet_flag.txt");
  if (fs.existsSync(sprintFlagPath)) {
    const flagContent = fs.readFileSync(sprintFlagPath, "utf-8").trim();
    if (flagContent) {
      const [taskId, actionType, ...rest] = flagContent.split("|");
      signals.push({
        source: `sprint_action:${actionType || "unknown"}`,
        description: `Sprint-driven tweet: task ${taskId} (${actionType}) — ${rest.join("|") || "no details"}`,
        task_id: parseInt(taskId, 10) || null,
      });
    }
    // Clean up the flag so it's not double-counted tomorrow
    fs.unlinkSync(sprintFlagPath);
  }

  // Check browse_notes for [SPRINT: task_id] tags
  const browseNotesPath = path.join(STATE, "browse_notes.md");
  if (fs.existsSync(browseNotesPath)) {
    const browseContent = fs.readFileSync(browseNotesPath, "utf-8");
    const sprintTags = browseContent.match(/\[SPRINT:\s*(\d+)\]/g);
    if (sprintTags && sprintTags.length > 0) {
      const uniqueIds = [...new Set(sprintTags.map(t => t.match(/\d+/)?.[0]).filter(Boolean))];
      signals.push({
        source: "browse_sprint_tags",
        description: `Browse notes tagged ${sprintTags.length} sprint-relevant findings for task(s): ${uniqueIds.join(", ")}`,
        task_ids: uniqueIds.map(id => parseInt(id, 10)),
      });
    }
  }

  // Check for ponder output
  const activePlan = loadJson(path.join(STATE, "active_plan.json"));
  if (activePlan?.execution_log) {
    const todayLogs = activePlan.execution_log.filter(e => e.date === d);
    for (const e of todayLogs) {
      signals.push({
        source: "execution_log",
        description: `${e.action}: ${(e.note || "").slice(0, 100)}`,
      });
    }
  }

  return signals;
}

// ── Match signals to tasks via Vertex ─────────────────────────────────────────

async function matchSignalsToTasks(signals, tasks) {
  if (signals.length === 0 || tasks.length === 0) return [];

  const taskList = tasks.map(t => `[${t.id}] "${t.title}" (${t.task_type}, status: ${t.status})`).join("\n");
  const signalList = signals.map((s, i) => `${i + 1}. [${s.source}] ${s.description}`).join("\n");

  const prompt = `You are tracking progress on a 30-day plan. Match today's signals to sprint tasks.

CURRENT TASKS:
${taskList}

TODAY'S SIGNALS:
${signalList}

For each signal that clearly advances or completes a task, return a match.
Only match if there's a genuine connection — don't force matches.
A task is "done" if the signal represents its completion. Otherwise mark "in_progress".

Respond in JSON:
{
  "matches": [
    {
      "task_id": 123,
      "signal_index": 1,
      "new_status": "in_progress|done",
      "accomplishment": "brief description of what was accomplished"
    }
  ],
  "unmatched_signals": [
    {
      "signal_index": 2,
      "accomplishment": "brief description — not tied to a specific task"
    }
  ]
}

If no matches, return { "matches": [], "unmatched_signals": [] }`;

  try {
    const raw    = await callVertex(prompt, 2000);
    const parsed = repairJson(raw);
    return parsed || { matches: [], unmatched_signals: [] };
  } catch (err) {
    console.error(`[sprint/tracker] signal matching failed: ${err.message}`);
    return { matches: [], unmatched_signals: [] };
  }
}

// ── Sprint retrospective via Vertex ───────────────────────────────────────────

async function generateRetro(sprint, tasks, accomplishments) {
  const taskSummary = tasks.map(t => {
    const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : "✗";
    return `${icon} ${t.title} (${t.task_type}) — ${t.status}`;
  }).join("\n");

  const accSummary = accomplishments
    .map(a => `- [${a.date}] ${a.description}`)
    .join("\n");

  const prompt = `You are Sebastian D. Hunter, reflecting on a completed sprint.

SPRINT: Week ${sprint.week} — "${sprint.goal}"
Period: ${sprint.start_date} to ${sprint.end_date}

TASKS:
${taskSummary}

ACCOMPLISHMENTS:
${accSummary || "(none recorded)"}

Write a brief, honest retrospective (3-5 sentences). What went well? What didn't?
What should change next week? Be specific and self-critical — not performative.

Respond as plain text (not JSON).`;

  try {
    const retro = await callVertex(prompt, 1000);
    return retro.trim();
  } catch (err) {
    console.error(`[sprint/tracker] retro generation failed: ${err.message}`);
    return `Week ${sprint.week} completed. Retro generation failed.`;
  }
}

// ── Main tracking logic ───────────────────────────────────────────────────────

/**
 * Run daily tracking for the active plan.
 * Returns: { action: "tracked"|"sprint_completed"|"plan_completed"|"no_sprint", ... }
 */
async function runDailyTracking(planId) {
  const d = today();
  console.log(`[sprint/tracker] running daily tracking for plan "${planId}" on ${d}`);

  const currentSprint = sprintDb.getCurrentSprint(planId);
  if (!currentSprint) {
    console.log("[sprint/tracker] no active sprint — skipping tracking");
    return { action: "no_sprint" };
  }

  const tasks   = sprintDb.getTasks(currentSprint.id);
  const signals = gatherTodaySignals();

  console.log(`[sprint/tracker] ${signals.length} signals found today, ${tasks.length} tasks in sprint`);

  // Match signals to tasks
  if (signals.length > 0 && tasks.some(t => t.status !== "done")) {
    const result = await matchSignalsToTasks(signals, tasks);

    // Apply matches
    for (const m of (result.matches || [])) {
      sprintDb.updateTaskStatus(m.task_id, m.new_status, null);
      sprintDb.addAccomplishment({
        plan_id:     planId,
        task_id:     m.task_id,
        date:        d,
        description: m.accomplishment,
        evidence:    signals[m.signal_index - 1]?.description || null,
      });
      console.log(`[sprint/tracker] task ${m.task_id} → ${m.new_status}: ${m.accomplishment}`);
    }

    // Record unmatched but noteworthy signals
    for (const u of (result.unmatched_signals || [])) {
      if (u.accomplishment) {
        sprintDb.addAccomplishment({
          plan_id:     planId,
          task_id:     null,
          date:        d,
          description: u.accomplishment,
          evidence:    signals[u.signal_index - 1]?.description || null,
        });
      }
    }
  }

  // Check if sprint should auto-complete (end date passed or all tasks done)
  const refreshedTasks = sprintDb.getTasks(currentSprint.id);
  const allDone        = refreshedTasks.length > 0 && refreshedTasks.every(t => t.status === "done");
  const pastEndDate    = currentSprint.end_date && d > currentSprint.end_date;

  let sprintCompleted = false;
  if (allDone || pastEndDate) {
    const reason = allDone ? "all tasks done" : "end date passed";
    console.log(`[sprint/tracker] completing sprint week ${currentSprint.week} (${reason})`);

    const accomplishments = sprintDb.getAccomplishments(planId);
    const retro = await generateRetro(currentSprint, refreshedTasks, accomplishments);
    sprintDb.completeSprint(currentSprint.id, retro);
    console.log(`[sprint/tracker] retro: ${retro.slice(0, 150)}...`);

    // Carry forward incomplete tasks to the next sprint
    const incompleteTasks = refreshedTasks.filter(t => t.status !== "done");
    if (incompleteTasks.length > 0 && !allDone) {
      const nextSprint = sprintDb.getSprints(planId).find(s => s.status === "not_started");
      if (nextSprint) {
        const carried = sprintDb.rolloverTasks(currentSprint.id, nextSprint.id);
        console.log(`[sprint/tracker] carried ${carried} incomplete task(s) to week ${nextSprint.week}`);
      } else {
        console.log(`[sprint/tracker] ${incompleteTasks.length} incomplete task(s) but no next sprint to carry forward to`);
      }
    }

    sprintCompleted = true;
  }

  // Write daily log
  const activeTasks = refreshedTasks
    .filter(t => t.status !== "done")
    .map(t => t.title)
    .join("; ");

  sprintDb.upsertDailyLog({
    plan_id:      planId,
    date:         d,
    focus:        currentSprint.goal,
    active_tasks: activeTasks || "(all done)",
    blockers:     null,
    notes:        `Signals: ${signals.length}, Matches applied: ${signals.length > 0 ? "yes" : "no"}`,
  });

  if (sprintCompleted) {
    // Check if this was the last sprint (week 4+)
    const allSprints = sprintDb.getSprints(planId);
    const maxWeek    = Math.max(...allSprints.map(s => s.week));
    if (maxWeek >= 4 && allSprints.every(s => s.status === "completed")) {
      console.log("[sprint/tracker] all sprints completed — plan may be done");
      return { action: "plan_completed", sprint_week: currentSprint.week };
    }
    return { action: "sprint_completed", sprint_week: currentSprint.week };
  }

  return { action: "tracked", sprint_week: currentSprint.week, tasks_remaining: activeTasks };
}

module.exports = { runDailyTracking, gatherTodaySignals };
