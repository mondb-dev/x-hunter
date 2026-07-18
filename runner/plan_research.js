#!/usr/bin/env node
'use strict';
/**
 * runner/plan_research.js — plan-driven deep research executor.
 *
 * Bridges the planning layer to the deep_research harness: when the active plan
 * carries open research questions, answer ONE per run with a full deep-research
 * pass and publish the resulting report to the website (publish_report). This is
 * what makes the "deep-research report" line in lib/capabilities.js executable
 * from a plan, not just reactively (X mentions / Telegram /dr).
 *
 * Question sources (first match wins):
 *   1. active_plan.research.open_questions[] — any action_type
 *   2. a research_sprint plan with no open questions → one report derived from
 *      the plan's compulsion/title (single-shot per plan)
 *
 * Progress persists in state/plan_research_state.json (reset when the active
 * plan changes) so each question is answered exactly once per plan.
 *
 * Invoked daily from the orchestrator maintenance block as a DETACHED process —
 * a deep pass runs 1-5 min, far beyond runScriptLog's 120s cap. Non-fatal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./lib/config');

const STATE_PATH = path.join(config.STATE_DIR, 'plan_research_state.json');
const ACTIVE_PLAN_PATH = path.join(config.STATE_DIR, 'active_plan.json');
const MAX_RUN_MS = 10 * 60 * 1000;

const log = (m) => console.log(`[plan_research] ${m}`);

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

function qHash(q) {
  return crypto.createHash('md5').update(String(q).toLowerCase().trim()).digest('hex').slice(0, 12);
}

async function main() {
  const plan = loadJson(ACTIVE_PLAN_PATH, null);
  if (!plan || plan.status !== 'active') { log('no active plan — nothing to do'); return; }

  const planKey = String(plan.title || 'untitled').slice(0, 120);
  let state = loadJson(STATE_PATH, null);
  if (!state || state.plan !== planKey) {
    state = { plan: planKey, done: [], results: [] };
  }

  let openQuestions = ((plan.research || {}).open_questions || [])
    .map((q) => String(q).trim()).filter(Boolean);

  // A plan can arrive without a research brief (e.g. re-grounded plans lose the
  // deep-dive brief match, leaving research: null). Derive researchable
  // questions ONCE from the plan itself so daily research still serves it.
  if (!openQuestions.length) {
    if (!Array.isArray(state.derived_questions)) {
      log('plan has no research.open_questions — deriving from the plan brief');
      try {
        const { reason } = require('./lib/compose');
        const raw = await reason(
`From this plan, list the 3-5 most valuable RESEARCHABLE questions — each must be answerable with web/X search, page reads, memory of observed posts, or on-chain token data (no "build/track/decide" items, no questions about Sebastian's own output).

PLAN: ${plan.title}
TYPE: ${plan.action_type || '?'}
COMPULSION: ${String(plan.compulsion || '').slice(0, 600)}
BRIEF: ${String(plan.brief || '').slice(0, 900)}

Each question standalone and specific (name actors, claims, mechanisms). Output ONLY a JSON array of question strings.`,
          { maxTokens: 500, tag: 'plan-research-derive' });
        const m = String(raw).replace(/```(?:json)?/gi, '').match(/\[[\s\S]*\]/);
        state.derived_questions = (m ? JSON.parse(m[0]) : []).map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
        log(`derived ${state.derived_questions.length} question(s)`);
      } catch (e) { log(`question derivation failed (non-fatal): ${e.message}`); state.derived_questions = []; }
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    }
    openQuestions = state.derived_questions;
  }

  const question = openQuestions.find((q) => !state.done.includes(qHash(q))) || null;
  if (!question) { log(`no unanswered research questions for plan "${planKey}"`); return; }

  log(`plan "${planKey}" → question: ${question.slice(0, 140)}`);
  // Delivery format follows the plan's action type: thread-shaped plans put
  // findings out as X threads, otherwise the model picks from the finished
  // research (report page vs thread; X Article once its driver exists).
  const FORMAT_BY_ACTION = { thread_series: 'thread', engage_campaign: 'thread', article_series: 'report' };
  const format = FORMAT_BY_ACTION[plan.action_type] || 'auto';
  const { researchAndDeliver } = require('./deep_research');
  const r = await researchAndDeliver(question, { source: 'plan', format });

  state.done.push(qHash(question));
  state.results.push({
    question,
    format: r.format || null,
    url: r.url || null,
    gated: r.gated || false,
    short: String(r.shortAnswer || (r.tweets && r.tweets[0]) || r.clarify || '').slice(0, 240),
    ts: new Date().toISOString(),
  });
  state.results = state.results.slice(-40);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  log(r.url ? `delivered as ${r.format}: ${r.url}` : r.gated ? 'withheld by quality gate (kept in state)' : 'research done (no delivery — result kept in state)');
}

// Hard watchdog: a wedged research pass must not leave a zombie process behind.
const killer = setTimeout(() => { log(`exceeded ${MAX_RUN_MS / 60000} min — aborting`); process.exit(1); }, MAX_RUN_MS);

main()
  .then(() => { clearTimeout(killer); process.exit(0); })
  .catch((e) => { log(`error (non-fatal): ${e.message}`); clearTimeout(killer); process.exit(0); });
