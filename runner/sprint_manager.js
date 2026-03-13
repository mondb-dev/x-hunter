#!/usr/bin/env node
/**
 * runner/sprint_manager.js — Orchestrator for the sprint lifecycle
 *
 * Called daily from run.sh in the maintenance block (after decision.js).
 * Non-fatal — exits 0 on any error.
 *
 * Lifecycle:
 *   1. SYNC:  Ensure active_plan.json is synced to sprints.db
 *   2. PLAN:  If no sprints exist → call planner.generateFullPlan()
 *   3. TRACK: Run daily tracking (signal detection, task matching, progress)
 *   4. NEXT:  If current sprint completed → plan next sprint or complete plan
 *   5. LOG:   Write sprint context for tweet prompt injection
 *
 * Reads:
 *   state/active_plan.json
 *   state/sprints.db
 *
 * Writes:
 *   state/sprints.db         (all sprint/task/accomplishment data)
 *   state/sprint_context.txt (injected into tweet agent prompt by run.sh)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT  = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state");

const ACTIVE_PLAN_PATH      = path.join(STATE, "active_plan.json");
const SPRINT_CONTEXT_PATH   = path.join(STATE, "sprint_context.txt");
const SPRINT_SNAPSHOT_PATH  = path.join(STATE, "sprint_snapshot.json");

const sprintDb = require("./sprint/db.js");
const planner  = require("./sprint/planner.js");
const tracker  = require("./sprint/tracker.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[sprint_manager] starting daily sprint cycle");

  // 1. Load active plan
  const activePlan = loadJson(ACTIVE_PLAN_PATH);
  if (!activePlan || activePlan.status !== "active") {
    console.log("[sprint_manager] no active plan — writing empty context and exiting");
    fs.writeFileSync(SPRINT_CONTEXT_PATH, "(no active plan)");
    process.exit(0);
  }

  const planId = activePlan.id || `plan_${activePlan.activated_date}`;
  console.log(`[sprint_manager] active plan: "${activePlan.title}" (${planId})`);

  // 2. SYNC — ensure plan exists in DB
  sprintDb.upsertPlan({
    plan_id:        planId,
    title:          activePlan.title,
    compulsion:     activePlan.compulsion,
    brief:          activePlan.brief,
    success_30d:    activePlan.success_30d,
    belief_axes:    activePlan.belief_axes,
    activated_date: activePlan.activated_date || today(),
  });

  // 3. PLAN — generate sprints if none exist
  const existingSprints = sprintDb.getSprints(planId);
  if (existingSprints.length === 0) {
    console.log("[sprint_manager] no sprints found — generating full plan");
    try {
      await planner.generateFullPlan(activePlan);
    } catch (err) {
      console.error(`[sprint_manager] full plan generation failed: ${err.message}`);
      fs.writeFileSync(SPRINT_CONTEXT_PATH, "(sprint planning in progress — generation failed, will retry)");
      process.exit(0);
    }
  }

  // 4. TRACK — daily progress tracking
  let trackResult;
  try {
    trackResult = await tracker.runDailyTracking(planId);
    console.log(`[sprint_manager] tracking result: ${trackResult.action}`);
  } catch (err) {
    console.error(`[sprint_manager] tracking failed: ${err.message}`);
    trackResult = { action: "error" };
  }

  // 5. NEXT — handle sprint transitions
  if (trackResult.action === "sprint_completed") {
    const sprints   = sprintDb.getSprints(planId);
    const nextReady = sprints.find(s => s.status === "not_started");

    if (nextReady) {
      // Pre-planned sprint exists — activate it
      const tasks = sprintDb.getTasks(nextReady.id);
      if (tasks.length === 0) {
        // Sprint exists but has no tasks — replan it
        console.log(`[sprint_manager] week ${nextReady.week} has no tasks — replanning`);
        try {
          await planner.generateNextSprint(activePlan, planId);
        } catch (err) {
          console.error(`[sprint_manager] next sprint planning failed: ${err.message}`);
        }
      } else {
        sprintDb.activateSprint(nextReady.id, today());
        console.log(`[sprint_manager] activated pre-planned week ${nextReady.week}`);
      }
    } else {
      // No more pre-planned sprints — generate next one
      const maxWeek = Math.max(...sprints.map(s => s.week));
      if (maxWeek < 4) {
        console.log("[sprint_manager] generating next sprint");
        try {
          await planner.generateNextSprint(activePlan, planId);
        } catch (err) {
          console.error(`[sprint_manager] next sprint planning failed: ${err.message}`);
        }
      } else {
        console.log("[sprint_manager] all 4 weeks done — plan complete");
        sprintDb.completePlan(planId, today());
      }
    }
  } else if (trackResult.action === "plan_completed") {
    console.log("[sprint_manager] plan marked complete");
    sprintDb.completePlan(planId, today());
  }

  // 6. LOG — write sprint context for tweet prompt
  const context = sprintDb.buildPromptContext(planId);
  fs.writeFileSync(SPRINT_CONTEXT_PATH, context);
  console.log(`[sprint_manager] sprint context written (${context.length} chars)`);

  // 7. SNAPSHOT — write JSON snapshot for the website /plan page
  const summary = sprintDb.getSprintSummary(planId);
  if (summary) {
    // Enrich with recent accomplishments
    const recentAccomplishments = sprintDb.getAccomplishments(planId, sprintDb.addDays(today(), -7));
    const snapshot = {
      ...summary,
      plan_id:        planId,
      brief:          activePlan.brief,
      compulsion:     activePlan.compulsion,
      success_30d:    activePlan.success_30d,
      belief_axes:    activePlan.belief_axes || [],
      accomplishments: recentAccomplishments.map(a => ({
        date:        a.date,
        description: a.description,
        evidence:    a.evidence,
        impact:      a.impact,
      })),
      snapshot_at: new Date().toISOString(),
    };
    fs.writeFileSync(SPRINT_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`[sprint_manager] sprint snapshot written`);
  }

  sprintDb.close();
  console.log("[sprint_manager] done");
}

main().catch(err => {
  console.error(`[sprint_manager] fatal: ${err.message}`);
  // Write a fallback context so tweet prompt doesn't break
  try {
    fs.writeFileSync(SPRINT_CONTEXT_PATH, "(sprint manager error — will retry)");
  } catch {}
  process.exit(0); // non-fatal to runner
});
