#!/usr/bin/env node
/**
 * runner/agenda_bootstrap.js — one-time state migration onto the research agenda
 * (runner/lib/research_agenda.js). Idempotent; DRY RUN unless --apply.
 *
 *   1. ontology   add the agenda's seeded axes (state/ontology.json, backup first)
 *   2. plan       install the agenda plan as the ONE active plan: previous active
 *                 plan → "superseded" in action_plans.json and sprints.db;
 *                 active_plan.json = agenda plan with research.open_questions =
 *                 the agenda's foundation + solution questions in dependency
 *                 order (orderedQuestions), so plan_research.js answers one per
 *                 day — foundations as reports, solutions as solution briefs
 *   3. vocation   run evaluate_vocation.js, which pins state/vocation.json +
 *                 vocation.md to the agenda (no LLM call in pinned mode)
 *   4. reset      clear the pre-pivot working context so the old beat cannot
 *                 leak into new prompts: browse notes, digests, drafts,
 *                 directives, discourse anchors, sprint context and the last
 *                 critique are archived under state/pre_pivot/<ts>/; open
 *                 pre-pivot stances are retired and open claims archived
 *                 (both keep their history, neither is deleted)
 *
 * sprint_manager.js generates the sprint tasks for the new plan on its next
 * daily run (or run it by hand).
 *
 * Run on the live checkout, in the sleep window:
 *   node runner/agenda_bootstrap.js            # dry run — prints what would change
 *   node runner/agenda_bootstrap.js --apply
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getAgenda, agendaQuestions, orderedQuestions } = require("./lib/research_agenda");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state");
const ONTO_PATH = path.join(STATE, "ontology.json");
const PLANS_PATH = path.join(STATE, "action_plans.json");
const ACTIVE_PATH = path.join(STATE, "active_plan.json");

const APPLY = process.argv.includes("--apply");
const TODAY = new Date().toISOString().slice(0, 10);
const log = (m) => console.log(`[agenda_bootstrap]${APPLY ? "" : " (dry run)"} ${m}`);

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function saveJson(p, data) {
  if (APPLY) fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function buildPlan(agenda) {
  const tracks = agenda.tracks.map(t => `${t.label}: ${t.why}`).join(" ");
  const questions = orderedQuestions(agenda);
  const nSolutions = agendaQuestions(agenda).filter(q => q.kind === "solution").length;
  return {
    id: `plan_${TODAY.replace(/-/g, "")}_agenda_${agenda.id}`,
    title: `${agenda.label} — Month 1`,
    compulsion:
      "Operator research agenda. AI is being deployed faster than anyone can show it is reliable, and " +
      "most public claims about it — from labs, boosters and doomers alike — go unchecked. The useful " +
      "thing I can add is solutions that hold up: grounded in evidence, specific enough to adopt, and " +
      "testable. I am an AI agent with a documented record of my own failures, so I can test some of " +
      "them on myself.",
    belief_axes: agenda.axes.map(a => a.id),
    action_type: "solution_series",
    brief:
      `Produce well-founded solution briefs for more useful, reliable and safe AI across four tracks. ${tracks} ` +
      "Each track first builds its evidence base (deep-research foundation reports), then turns it into " +
      "solution briefs (runner/solution_brief.js: problem → cited evidence → mechanism → falsifiable test → " +
      "risks, red-teamed and gated before publishing). One question per day via plan_research.js; threads " +
      "and articles carry the published solutions to practitioners.",
    success_30d:
      `At least ${Math.ceil(nSolutions / 2)} solution briefs published that passed the red-team and grounding ` +
      "gate, covering all four tracks, each built on a published foundation report; at least one self-study " +
      "solution specific enough for the operator to test on Sebastian's own pipeline; every withheld brief " +
      "logged with its gate failure in state/solutions.jsonl.",
    status: "active",
    created: TODAY,
    activated_date: TODAY,
    decided_date: TODAY,
    source: `research_agenda:${agenda.id}`,
    execution_log: [{ date: TODAY, action: "activated", note: `installed by agenda_bootstrap.js (research agenda: ${agenda.id})` }],
    research: {
      feasibility: "high",
      feasibility_notes: "Every step is research/synthesize/publish on existing tools: deep research, solution_brief, report pages, threads, articles.",
      audience: "Practitioners deploying AI, AI safety and reliability researchers, lab and policy people who need proposals they can act on.",
      reach_strategy: "Tag the lab, author or project a solution builds on; thread each published brief with its test; cross-post to LinkedIn.",
      effort: "medium",
      open_questions: questions,
      milestones: [
        { week: 1, goal: "Foundation reports published on all four tracks; first solution briefs drafted on top of them." },
        { week: 2, goal: "First round of solution briefs published (one per track) — each red-teamed, grounded, with a stated test." },
        { week: 4, goal: "Second round of solutions published; a synthesis of which proposals are strongest and what testing them would take." },
      ],
      risks: [
        "The X home feed stays PH-heavy until follows shift — RSS and source pages carry the agenda meanwhile.",
        "A brief can be well-argued and still wrong: status stays 'proposed — not yet tested' until a test is run.",
        "The gate may withhold many drafts early on — that is the point; check state/solutions.jsonl for why.",
      ],
    },
    first_sprint: {
      week_1_goal: "Publish the four foundation reports and start the first solution briefs on top of them.",
      first_actions: [
        "Foundation report: how the frontier labs' safety frameworks changed since their first versions",
        "Foundation report: how reliable chain-of-thought monitoring is, given reasoning-trace faithfulness research",
        "Foundation report: what METR's task-horizon measurements show, and the critiques of extrapolating them",
        "Foundation report: LLM calibration research vs Sebastian's own 79%-stated / 29%-actual prediction record",
      ],
      success_signal: "Four foundation reports live on the website and the first solution brief through the red-team.",
    },
  };
}

// Working-context files that describe the OLD beat. They are inputs to the next
// prompts, so a pivot that leaves them in place keeps writing the old agent's
// posts. History, ledgers and logs are never touched.
const RESET_FILES = [
  "browse_notes.md", "feed_digest.txt", "topic_summary.txt", "memory_recall.txt",
  "tweet_draft.txt", "quote_draft.txt", "thread_draft.json", "curiosity_directive.txt",
  "curiosity_hint.json", "comment_candidates.txt", "discourse_digest.txt",
  "discourse_anchors.jsonl", "article_meta.md", "sprint_context.txt", "reading_url.txt",
  "critique.txt", "agent_scratchpad.md",
];

/** Archive the pre-pivot working context and retire pre-pivot commitments. */
function resetContext(agenda) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = path.join(STATE, "pre_pivot", stamp);
  let moved = 0;
  for (const f of RESET_FILES) {
    const src = path.join(STATE, f);
    if (!fs.existsSync(src)) continue;
    log(`archive + clear state/${f}`);
    if (APPLY) {
      fs.mkdirSync(archive, { recursive: true });
      fs.copyFileSync(src, path.join(archive, f));
      fs.writeFileSync(src, f.endsWith(".json") ? "{}" : "");
    }
    moved++;
  }
  if (!moved) log("no pre-pivot context files to archive");

  // Open stances from the old beat are not current positions.
  const stancesPath = path.join(STATE, "stances.json");
  const doc = loadJson(stancesPath, null);
  if (doc && Array.isArray(doc.stances)) {
    const { isOnAgenda } = require("./lib/research_agenda");
    let retired = 0;
    for (const st of doc.stances) {
      if (st.status !== "open") continue;
      if (isOnAgenda(`${st.event || ""} ${st.question || ""} ${st.side || ""}`, agenda)) continue;
      st.status = "retired";
      st.retired_at = TODAY;
      st.retired_reason = `off-agenda at the ${agenda.id} pivot — never resolved, not counted as right or wrong`;
      retired++;
    }
    if (retired) { log(`retire ${retired} pre-pivot stance(s)`); saveJson(stancesPath, doc); }
  }

  // The public X bio still advertises the old vocation. Stage the agenda bio for
  // the operator (nothing posts it — see research_agenda.bio).
  const profilePath = path.join(STATE, "profile.json");
  const profile = loadJson(profilePath, null);
  if (profile && agenda.bio && profile.bio !== agenda.bio && profile.pending_bio?.text !== agenda.bio) {
    log(`stage new X bio (operator must set it on X): "${agenda.bio}"`);
    log(`  current bio: "${profile.bio}"`);
    profile.pending_bio = { text: agenda.bio, proposed_at: TODAY, reason: `research agenda ${agenda.id}` };
    saveJson(profilePath, profile);
  }

  // Open claims from the old beat would keep appearing as "unresolved claims".
  const trackerPath = path.join(STATE, "claim_tracker.json");
  const tracker = loadJson(trackerPath, null);
  if (tracker && Array.isArray(tracker.claims)) {
    let archived = 0;
    for (const c of tracker.claims) {
      if (c.status !== "unverified" && c.status !== "contested") continue;
      c.status = "archived_pre_pivot";
      c.archived_at = TODAY;
      archived++;
    }
    if (archived) { log(`archive ${archived} open pre-pivot claim(s)`); saveJson(trackerPath, tracker); }
  }
}

async function main() {
  const agenda = getAgenda();
  if (!agenda) { log("RESEARCH_AGENDA is off — nothing to do"); return; }
  log(`agenda: ${agenda.id} (${agenda.mode})`);

  // ── 1. Seed axes ────────────────────────────────────────────────────────────
  const onto = loadJson(ONTO_PATH, null);
  if (!onto || !Array.isArray(onto.axes)) throw new Error("state/ontology.json missing or malformed");
  const have = new Set(onto.axes.map(a => a.id));
  const now = new Date().toISOString();
  const toAdd = agenda.axes.filter(a => !have.has(a.id));
  for (const a of toAdd) {
    onto.axes.push({
      id: a.id, label: a.label, left_pole: a.left_pole, right_pole: a.right_pole,
      score: 0, confidence: 0, topics: a.topics || [],
      created_at: now, last_updated: now, evidence_log: [],
      seeded_by: `research_agenda:${agenda.id}`,
    });
    log(`seed axis ${a.id}`);
  }
  if (toAdd.length) {
    // *.bak is gitignored — keeps the multi-MB backup out of the runner's state commits.
    if (APPLY) fs.copyFileSync(ONTO_PATH, path.join(STATE, `ontology.${Date.now()}.bak`));
    onto.last_updated = now;
    saveJson(ONTO_PATH, onto);
  } else {
    log("all agenda axes already present");
  }

  // ── 2. Install the agenda plan ──────────────────────────────────────────────
  const active = loadJson(ACTIVE_PATH, null);
  const source = `research_agenda:${agenda.id}`;
  if (active && active.status === "active" && active.source === source) {
    log(`agenda plan already active: "${active.title}"`);
  } else {
    const plan = buildPlan(agenda);
    const plans = loadJson(PLANS_PATH, []);
    for (const p of plans) {
      if (p.status === "active") {
        p.status = "superseded";
        p.superseded_date = TODAY;
        p.execution_log = p.execution_log || [];
        p.execution_log.push({ date: TODAY, action: "superseded", note: `replaced by research agenda plan ${plan.id}` });
        log(`supersede plan "${p.title}"`);
      }
    }
    plans.push(plan);
    saveJson(PLANS_PATH, plans);
    saveJson(ACTIVE_PATH, plan);
    log(`active plan → "${plan.title}" (${plan.research.open_questions.length} open questions)`);

    if (APPLY) {
      const { loadSprintDb } = require("./lib/db_backend");
      const db = loadSprintDb();
      try {
        const n = await db.supersedeOtherPlans(plan.id, TODAY);
        log(`sprints.db: ${n} other active plan(s) marked superseded`);
      } finally {
        try { await db.close(); } catch { /* optional */ }
      }
    }
  }

  // ── 3. Pin vocation (evaluate_vocation.js pinned mode — no LLM call) ────────
  if (APPLY) {
    execSync(`node "${path.join(__dirname, "evaluate_vocation.js")}"`, { stdio: "inherit", cwd: ROOT });
  } else {
    log(`would run evaluate_vocation.js → vocation "${agenda.vocation.label}"`);
  }

  // ── 4. Reset the pre-pivot working context ─────────────────────────────────
  resetContext(agenda);

  // ── 5. Refresh the public export so /data matches the new state ────────────
  if (APPLY) {
    try {
      require("./export_public_data").exportAll(path.join(ROOT, "web", "public", "data"));
      log("refreshed public export (web/public/data)");
    } catch (e) { log(`public export failed (non-fatal): ${e.message}`); }
  } else {
    log("would refresh the public export (web/public/data)");
  }

  log(APPLY
    ? "done. Next: node runner/sprint_manager.js (or wait for the daily run) to plan sprints for the new plan."
    : "dry run complete — re-run with --apply to write.");
}

main().catch(e => { console.error(`[agenda_bootstrap] error: ${e.message}`); process.exit(1); });
