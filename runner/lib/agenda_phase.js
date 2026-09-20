"use strict";
/**
 * runner/lib/agenda_phase.js — where the research agenda is in its life cycle,
 * and what that implies for the rest of the runner.
 *
 * The agenda (lib/research_agenda.js) runs its whole FOUNDATION phase before any
 * solution brief (orderedQuestions). This module answers the operational half of
 * that: during the foundation phase Sebastian is a researcher, not a poster —
 *
 *   researchPerDay        orchestrator.js runs plan_research this many times a
 *                         day instead of once (agenda.boot.research_per_day)
 *   holdOutbound          x_control.js suppresses tweets/quotes/reposts; replies
 *                         to people are NOT held (answering a human is not
 *                         broadcasting an ungrounded opinion)
 *   pauseFeedEngagement   pre_browse.js skips the X-feed engagement prep
 *                         (comment candidates, discourse scan/digest). Reading,
 *                         RSS and evidence filing continue — that is how the
 *                         seeded axes get grounded alongside the research.
 *
 * The policy is deliberately inert until the agenda plan is actually installed
 * (agenda_bootstrap.js --apply sets active_plan.source = "research_agenda:<id>").
 * Merging this code must not, on its own, silence a system whose pivot has not
 * been applied yet.
 *
 * AGENDA_BOOT=off disables the boot policy while leaving the agenda itself on.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE = path.join(ROOT, "state");
const PLAN_PATH = path.join(STATE, "active_plan.json");
const RESEARCH_STATE = path.join(STATE, "plan_research_state.json");

const DEFAULT_BOOT = {
  research_per_day: 3,
  hold_outbound: true,
  pause_feed_engagement: true,
};

const IDLE = {
  active: false,
  phase: "none",
  foundations: 0,
  foundationsDone: 0,
  foundationsRemaining: 0,
  researchPerDay: 1,
  holdOutbound: false,
  pauseFeedEngagement: false,
  reason: "no agenda plan active",
};

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

/** True once agenda_bootstrap.js --apply has installed the agenda's plan. */
function agendaPlanInstalled(agenda) {
  const plan = readJson(PLAN_PATH);
  if (!plan || plan.status !== "active") return false;
  return String(plan.source || "") === `research_agenda:${agenda.id}`;
}

function agendaPhase() {
  if (String(process.env.AGENDA_BOOT || "").toLowerCase() === "off") {
    return { ...IDLE, reason: "AGENDA_BOOT=off" };
  }
  const { getAgenda, agendaQuestions } = require("./research_agenda");
  const agenda = getAgenda();
  if (!agenda) return { ...IDLE, reason: "no research agenda" };
  if (!agendaPlanInstalled(agenda)) return { ...IDLE, reason: "agenda plan not installed (run agenda_bootstrap.js --apply)" };

  const boot = { ...DEFAULT_BOOT, ...(agenda.boot || {}) };
  const foundations = agendaQuestions(agenda).filter((q) => q.kind === "foundation");
  const results = (readJson(RESEARCH_STATE, {}) || {}).results;
  const answered = new Set(
    (Array.isArray(results) ? results : [])
      .filter((r) => r && r.kind === "foundation" && r.question)
      .map((r) => String(r.question))
  );
  const done = foundations.filter((f) => answered.has(f.question)).length;
  const remaining = Math.max(0, foundations.length - done);
  const inFoundation = remaining > 0;

  return {
    active: true,
    agendaId: agenda.id,
    phase: inFoundation ? "foundation" : "solutions",
    foundations: foundations.length,
    foundationsDone: done,
    foundationsRemaining: remaining,
    researchPerDay: inFoundation ? Math.max(1, parseInt(boot.research_per_day, 10) || 1) : 1,
    holdOutbound: inFoundation && boot.hold_outbound !== false,
    pauseFeedEngagement: inFoundation && boot.pause_feed_engagement !== false,
    reason: inFoundation
      ? `foundation phase — ${done}/${foundations.length} foundation reports done`
      : "foundation phase complete",
  };
}

/** One line for logs: "[agenda] foundation phase — 4/15 done, outbound held". */
function phaseSummary(p = agendaPhase()) {
  if (!p.active) return `[agenda] boot policy inactive (${p.reason})`;
  const bits = [p.reason];
  if (p.holdOutbound) bits.push("outbound held");
  if (p.pauseFeedEngagement) bits.push("feed engagement paused");
  if (p.researchPerDay > 1) bits.push(`${p.researchPerDay} research passes/day`);
  return `[agenda] ${bits.join(", ")}`;
}

module.exports = { agendaPhase, phaseSummary, DEFAULT_BOOT };
