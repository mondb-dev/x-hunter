#!/usr/bin/env node
'use strict';
/**
 * runner/solution_brief.js — the research agenda's final product: a well-founded
 * SOLUTION BRIEF for more useful, reliable or safe AI (runner/lib/research_agenda.js).
 *
 * Research alone is the foundation; this turns it into a proposal someone can
 * act on, and refuses to publish one that isn't grounded.
 *
 *   1. FOUNDATION  deepResearch(question) — plus the track's earlier foundation
 *                  reports and (self-study) the first-party dossier as context
 *   2. DRAFT       problem → cited evidence → prior approaches → mechanism →
 *                  falsifiable test → expected outcome → risks
 *   3. RED-TEAM    independent skeptical review (objections by severity,
 *                  unsupported claims, prior work, test quality, verdict)
 *   4. REVISE      address the review, then re-review (≤ MAX_REVIEWS reviews,
 *                  one revision between each)
 *   5. GATE        mechanical, not model-judged: every evidence source was
 *                  actually retrieved (≥2 actually read); ≥3 evidence items; a
 *                  test with metric + success threshold + falsifier; the FINAL
 *                  review has no fatal and ≤ MAX_OPEN_MAJOR major objections
 *                  (those are shown on the page); confidence capped at MAX_CONF
 *   6. PUBLISH     website report page (kind "solution") + state/solutions.jsonl
 *                  ledger + a [SOLUTION] line in browse_notes.md so the tweet
 *                  cycle can share it. Withheld briefs are ledgered too.
 *
 * Cost: one deep-research pass (~20-40 calls, sonnet) + 2-6 calls on
 * CLAUDE_SOLUTION_MODEL (default "opus") for draft / review / revise.
 *
 * Called by runner/plan_research.js for agenda questions of kind "solution".
 * CLI: node runner/solution_brief.js "<question>" [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./lib/config');
const { reason } = require('./lib/compose');

const LEDGER = path.join(config.STATE_DIR, 'solutions.jsonl');
const MODEL = process.env.CLAUDE_SOLUTION_MODEL || 'opus';
const MAX_CONF = 80;          // no untested proposal is published as >80% likely to work
const MIN_EVIDENCE = 3;
const MIN_READ = 2;           // evidence items whose source page was actually fetched
const SELF_SOURCE = /operating logs/i;
const MAX_REVIEWS = 3;        // red-team passes; a revision runs between each
const MAX_OPEN_MAJOR = 2;     // major objections the final review may leave standing
// Smoke test 2026-09-16: with 1 revision the final review still had 6 open
// major objections and a revision artifact slipped through — too lenient.

const log = (m) => console.log(`[solution_brief] ${m}`);
const cleanJson = (raw) => { const m = String(raw).replace(/```(?:json)?/gi, '').match(/[[{][\s\S]*[}\]]/); return m ? JSON.parse(m[0]) : null; };
const think = (prompt, tag, maxTokens = 3000) => reason(prompt, { tag, maxTokens, claudeModel: MODEL });

// ── Grounding pool ────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s)"'\]<>,|]+/g;
function normUrl(u) {
  return String(u).trim().replace(/[.,;:)\]]+$/, '').replace(/#.*$/, '').replace(/\/$/, '')
    .replace(/^http:/i, 'https:').replace(/^https:\/\/www\./i, 'https://').toLowerCase();
}

/** URLs the research actually touched: `read` = fetched pages, `seen` = anything retrieved. */
function groundingPool(res, extraText = '') {
  const read = new Set();
  const seen = new Set();
  for (const f of res.findings || []) {
    if (f.tool === 'fetch' && /^https?:/i.test(String(f.input))) read.add(normUrl(f.input));
    for (const u of `${f.input || ''} ${typeof f.result === 'string' ? f.result : JSON.stringify(f.result || '')}`.match(URL_RE) || []) seen.add(normUrl(u));
  }
  for (const u of `${res.report || ''} ${extraText}`.match(URL_RE) || []) seen.add(normUrl(u));
  for (const u of read) seen.add(u);
  return { read, seen };
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SCHEMA = `{
  "title": "specific, <= 90 chars — names the fix, not the topic",
  "one_line": "the proposal in one sentence",
  "problem": "what fails today, for whom, and how we know (2-4 sentences)",
  "evidence": [{"claim": "one load-bearing fact", "source": "exact URL from ALLOWED SOURCES"}],
  "prior_approaches": [{"approach": "...", "limitation": "why it is not enough", "source": "URL or empty"}],
  "proposal": {"mechanism": "exactly what changes and who does what — concrete enough to implement", "why_it_should_work": "the causal argument, tied to the evidence items", "who_implements": "labs / deployers / policymakers / researchers / Sebastian's operator"},
  "test": {"design": "how to test it", "metric": "what is measured", "success_threshold": "the result that counts as working", "falsified_if": "the result that shows it does not work", "timeframe": "how long"},
  "expected_outcome": {"prediction": "what you expect the test to show", "confidence_pct": 0},
  "risks": ["failure modes, costs, side effects, misuse potential"],
  "open_questions": ["what the evidence cannot yet settle"],
  "self_test": "if this can be tested on Sebastian's own pipeline, how — else empty string"
}`;

function draftPrompt({ question, trackLabel, report, allowed, context }) {
  const { agendaBlock } = require('./lib/research_agenda');
  return `You are Sebastian D. Hunter writing a SOLUTION BRIEF — a well-founded proposal for more useful, reliable or safe AI. Track: ${trackLabel || 'general'}.

${agendaBlock('lens')}

QUESTION: ${question}

${context ? `FOUNDATION CONTEXT (earlier foundation research and first-party data):\n${context.slice(0, 3500)}\n\n` : ''}RESEARCH REPORT (this question's evidence base):
${String(report || '').slice(0, 7000)}

ALLOWED SOURCES (URLs the research actually retrieved — cite ONLY these, verbatim${context && SELF_SOURCE.test(context) ? `; first-party facts may cite "Sebastian's operating logs"` : ''}):
${allowed.slice(0, 60).map((u) => `- ${u}`).join('\n') || '(none)'}

Rules:
- At least ${MIN_EVIDENCE} evidence items; every source copied exactly from ALLOWED SOURCES. Never invent a number, study, or URL.
- The mechanism must be concrete (who does what, differently) — not "raise awareness", "more research", or "collaboration".
- Say how it would be proven WRONG. An untestable proposal is not a solution.
- Engage the strongest existing approaches honestly; if one already solves this, say so and propose the missing piece instead.
- confidence_pct is your honest probability the test succeeds — this is untested, so be conservative (<= ${MAX_CONF}).
- If the evidence genuinely supports no solution, output {"no_solution": true, "why": "..."} instead.

Output ONLY JSON:
${SCHEMA}`;
}

function reviewPrompt({ question, brief, report }) {
  return `You are an independent, skeptical senior reviewer — an ML researcher who has also run AI systems in production. Review this SOLUTION BRIEF before it is published under its author's name. You did not write it; your job is to find what is wrong.

QUESTION: ${question}

RESEARCH IT WAS BUILT ON (excerpt):
${String(report || '').slice(0, 4000)}

BRIEF:
${JSON.stringify(brief, null, 2).slice(0, 9000)}

Check: Is every load-bearing claim actually supported by its cited source and the research? Does the mechanism follow from the evidence, or is it a leap? Does this already exist (then what is new)? Could the test actually falsify it? What is the strongest objection a practitioner would raise? Any misuse or harm risk left out? Is the confidence honest?

Severity: "fatal" = the brief should not be published as-is; "major" = must be addressed; "minor" = worth fixing.
Output ONLY JSON:
{"objections":[{"objection":"...","severity":"fatal|major|minor"}],"unsupported_claims":["..."],"prior_work":"...","test_quality":"...","verdict":"sound|revise|reject","fixes":["specific changes"]}`;
}

function revisePrompt({ question, brief, review, allowed }) {
  return `Revise this SOLUTION BRIEF to address the reviewer. Fix or drop unsupported claims (cite only ALLOWED SOURCES, verbatim), answer every fatal and major objection in the brief itself, and lower confidence if the review shows it was too high. If an objection cannot be answered, say so in open_questions or risks — do not paper over it.

QUESTION: ${question}

BRIEF:
${JSON.stringify(brief, null, 2).slice(0, 9000)}

REVIEW:
${JSON.stringify(review, null, 2).slice(0, 4000)}

ALLOWED SOURCES:
${allowed.slice(0, 60).map((u) => `- ${u}`).join('\n') || '(none)'}

Output ONLY the revised JSON in the same schema, plus "responses": [{"objection": "...", "response": "how the brief now handles it"}].`;
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/**
 * Mechanical foundation checks. Drops evidence whose source was never
 * retrieved (and reports it), then decides publishability.
 */
function gate(brief, review, pool, { allowSelf = false } = {}) {
  const failures = [];
  const dropped = [];
  const ev = [];
  for (const e of Array.isArray(brief.evidence) ? brief.evidence : []) {
    const src = String((e && e.source) || '').trim();
    if (!e || !e.claim || !src) continue;
    if (allowSelf && SELF_SOURCE.test(src)) { ev.push({ ...e, read: true, self: true }); continue; }
    const n = normUrl(src);
    if (pool.seen.has(n)) ev.push({ ...e, source: src, read: pool.read.has(n) });
    else dropped.push(src);
  }
  brief.evidence = ev;
  if (ev.length < MIN_EVIDENCE) failures.push(`only ${ev.length} grounded evidence item(s) (need ${MIN_EVIDENCE})`);
  if (ev.filter((e) => e.read).length < MIN_READ) failures.push(`fewer than ${MIN_READ} evidence sources were actually read`);
  const t = brief.test || {};
  if (!t.metric || !t.success_threshold || !t.falsified_if) failures.push('test lacks metric / success threshold / falsifier');
  const p = brief.proposal || {};
  if (!p.mechanism || String(p.mechanism).length < 80) failures.push('mechanism missing or too vague');
  const eo = brief.expected_outcome || (brief.expected_outcome = {});
  const conf = Number(eo.confidence_pct);
  if (!Number.isFinite(conf)) failures.push('no stated confidence');
  else if (conf > MAX_CONF) eo.confidence_pct = MAX_CONF;
  if (!review || review.verdict === 'reject') failures.push(`red-team verdict: ${review ? 'reject' : 'missing'}`);
  const open = (review && review.objections) || [];
  const fatal = open.filter((o) => o.severity === 'fatal');
  if (fatal.length) failures.push(`unresolved fatal objection(s): ${fatal.map((o) => o.objection).join(' | ').slice(0, 300)}`);
  const major = open.filter((o) => o.severity === 'major');
  if (major.length > MAX_OPEN_MAJOR) failures.push(`${major.length} unresolved major objections (max ${MAX_OPEN_MAJOR})`);
  return { ok: !failures.length, failures, dropped };
}

// ── Publish ───────────────────────────────────────────────────────────────────

const md = (items) => items.filter(Boolean).join('\n');

function toBlocks(brief, { track, review, foundations, confidence }) {
  const t = brief.test || {};
  const p = brief.proposal || {};
  const eo = brief.expected_outcome || {};
  const blocks = [
    { type: 'callout', tone: 'info', title: 'Proposal:', text: brief.one_line || brief.title },
    { type: 'keyvalue', items: [
      { k: 'Track', v: track || '—' },
      { k: 'Status', v: 'Proposed — not yet tested' },
      { k: 'Confidence the test succeeds', v: eo.confidence_pct != null ? `${eo.confidence_pct}%` : '—' },
      { k: 'Evidence base', v: `${(brief.evidence || []).length} cited items${confidence != null ? `; research confidence ${confidence}%` : ''}` },
      { k: 'Red-team verdict', v: (review && review.verdict) || '—' },
    ] },
    { type: 'heading', text: 'The problem' },
    { type: 'paragraph', text: brief.problem || '' },
    { type: 'heading', text: 'Evidence' },
    { type: 'markdown', md: md((brief.evidence || []).map((e) => `- ${e.claim} — ${e.self ? "Sebastian's operating logs" : `[source](${e.source})`}`)) },
  ];
  if ((brief.prior_approaches || []).length) {
    blocks.push({ type: 'heading', text: "What's been tried" });
    blocks.push({ type: 'markdown', md: md(brief.prior_approaches.map((a) => `- **${a.approach}** — ${a.limitation}${a.source ? ` ([source](${a.source}))` : ''}`)) });
  }
  blocks.push({ type: 'heading', text: 'The proposal' });
  blocks.push({ type: 'markdown', md: md([
    `**Mechanism.** ${p.mechanism || ''}`, '',
    `**Why it should work.** ${p.why_it_should_work || ''}`, '',
    p.who_implements ? `**Who implements it.** ${p.who_implements}` : '',
  ]) });
  blocks.push({ type: 'heading', text: 'How to test it' });
  blocks.push({ type: 'keyvalue', items: [
    { k: 'Design', v: t.design || '—' }, { k: 'Metric', v: t.metric || '—' },
    { k: 'Counts as working', v: t.success_threshold || '—' }, { k: 'Proven wrong if', v: t.falsified_if || '—' },
    { k: 'Timeframe', v: t.timeframe || '—' }, { k: 'Expected result', v: eo.prediction || '—' },
  ] });
  if (brief.self_test) blocks.push({ type: 'callout', tone: 'info', title: 'Testable on Sebastian himself:', text: brief.self_test });
  blocks.push({ type: 'heading', text: 'Risks and open questions' });
  blocks.push({ type: 'markdown', md: md([...(brief.risks || []).map((r) => `- ${r}`), ...(brief.open_questions || []).map((q) => `- *Open:* ${q}`)]) });
  const responses = brief.responses || [];
  if ((review && (review.objections || []).length) || responses.length) {
    blocks.push({ type: 'heading', text: 'Red-team' });
    blocks.push({ type: 'markdown', md: md([
      ...responses.map((r) => `- **Addressed:** ${r.objection} → ${r.response}`),
      ...((review && review.objections) || []).map((o) => `- **Still open (${o.severity}):** ${o.objection}`),
    ]) });
  }
  if (foundations.length) {
    blocks.push({ type: 'heading', text: 'Built on' });
    blocks.push({ type: 'sources', items: foundations.map((f) => ({ url: f.url, title: f.question.slice(0, 120) })) });
  }
  const sources = [...new Set((brief.evidence || []).filter((e) => !e.self).map((e) => e.source))];
  if (sources.length) blocks.push({ type: 'sources', items: sources.slice(0, 12).map((url) => ({ url })) });
  return blocks;
}

function ledger(entry) {
  try { fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n'); } catch (e) { log(`ledger write failed: ${e.message}`); }
}

function noteForTweetCycle(title, oneLine, url) {
  try {
    const line = `- [SOLUTION] ${title}: ${oneLine}${url ? ` (${url})` : ''}\n`;
    fs.appendFileSync(config.BROWSE_NOTES_PATH, line);
  } catch { /* non-fatal */ }
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * @param {string} question
 * @param {{track?: string, foundations?: {question,url,short}[], dossier?: string, live?: boolean}} opts
 * @returns {Promise<{url, title, one_line, gated, reason, failures?}>}
 */
async function solutionBrief(question, { track = null, foundations = [], dossier = null, live = true } = {}) {
  const { deepResearch } = require('./deep_research');
  const foundationText = foundations.length
    ? 'Earlier foundation reports on this track:\n' + foundations.map((f) => `- ${f.question}\n  finding: ${f.short || '(see report)'}\n  report: ${f.url}`).join('\n')
    : '';
  const context = [dossier, foundationText].filter(Boolean).join('\n\n');
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.createHash('sha1').update(question).digest('hex').slice(0, 8)}`;
  const base = { id, ts: new Date().toISOString(), question, track };

  // 1. Foundation
  const res = await deepResearch(question, { maxFetch: 5, allowTree: true, maxVerify: 3, dossier: context || null });
  if (res.bailed) { log(`research bailed: ${res.clarify}`); ledger({ ...base, status: 'bailed', reason: res.clarify }); return { gated: true, reason: 'research_bailed' }; }
  const a = res.assessment || {};
  if (a.compromised) { log(`research compromised: ${a.compromised_why}`); ledger({ ...base, status: 'withheld', reason: `research compromised: ${a.compromised_why}` }); return { gated: true, reason: 'research_compromised' }; }
  const pool = groundingPool(res, foundationText);
  const allowed = [...pool.read, ...[...pool.seen].filter((u) => !pool.read.has(u))];
  const allowSelf = !!dossier;
  log(`foundation: ${res.findings ? res.findings.length : 0} findings, ${pool.read.size} pages read, ${pool.seen.size} URLs retrieved`);

  // 2. Draft
  let brief = cleanJson(await think(draftPrompt({ question, trackLabel: track, report: res.report, allowed, context }), 'solution:draft', 3500));
  if (!brief) { ledger({ ...base, status: 'failed', reason: 'draft_unparseable' }); return { gated: true, reason: 'draft_unparseable' }; }
  if (brief.no_solution) {
    log(`no solution supported: ${brief.why}`);
    ledger({ ...base, status: 'no_solution', reason: brief.why });
    return { gated: true, reason: 'no_solution', why: brief.why };
  }

  // 3-4. Red-team → revise, until sound or MAX_REVIEWS reviews
  let review = null;
  for (let round = 1; round <= MAX_REVIEWS; round++) {
    review = cleanJson(await think(reviewPrompt({ question, brief, report: res.report }), 'solution:review', 1500));
    if (!review) { log(`review round ${round} unparseable`); break; }
    const serious = (review.objections || []).filter((o) => o.severity !== 'minor').length;
    log(`review round ${round}: ${review.verdict} (${serious} fatal/major objection(s))`);
    if (review.verdict === 'sound' || review.verdict === 'reject' || round === MAX_REVIEWS) break;
    const revised = cleanJson(await think(revisePrompt({ question, brief, review, allowed }), 'solution:revise', 4000));
    if (revised && !revised.no_solution) brief = revised;
  }

  // 5. Gate
  const g = gate(brief, review, pool, { allowSelf });
  if (g.dropped.length) log(`dropped ${g.dropped.length} ungrounded source(s): ${g.dropped.slice(0, 3).join(', ')}`);
  const entry = {
    ...base, title: brief.title, one_line: brief.one_line,
    test: brief.test, expected_outcome: brief.expected_outcome, self_test: brief.self_test || '',
    review_verdict: review && review.verdict, evidence_count: (brief.evidence || []).length,
    foundations: foundations.map((f) => f.url),
  };
  if (!g.ok) {
    log(`GATE: withheld — ${g.failures.join('; ')}`);
    ledger({ ...entry, status: 'withheld', gate_failures: g.failures });
    return { gated: true, reason: 'gate', failures: g.failures, title: brief.title };
  }

  // 6. Publish
  if (!live) {
    log('dry run — brief passed the gate, not publishing');
    console.log(JSON.stringify(brief, null, 2));
    return { gated: false, dryRun: true, title: brief.title, one_line: brief.one_line };
  }
  let url = null;
  try {
    const { publishReport } = require('./publish_report');
    url = await publishReport({
      title: String(brief.title).slice(0, 120), summary: brief.one_line, kind: 'solution', source: 'solution_brief',
      blocks: toBlocks(brief, { track, review, foundations, confidence: a.confidence_pct }),
    });
  } catch (e) { log(`publish failed: ${e.message}`); }
  ledger({ ...entry, status: url ? 'proposed' : 'publish_failed', url });
  if (url) noteForTweetCycle(brief.title, brief.one_line, url);
  log(url ? `published: ${url}` : 'publish failed (kept in ledger)');
  return { gated: false, url, title: brief.title, one_line: brief.one_line };
}

module.exports = { solutionBrief, gate, groundingPool, normUrl };

if (require.main === module) {
  const args = process.argv.slice(2);
  const question = args.filter((x) => !x.startsWith('--')).join(' ').trim();
  if (!question) { console.error('usage: node runner/solution_brief.js "<question>" [--dry-run]'); process.exit(1); }
  const { questionMeta, selfStudyDossier } = require('./lib/research_agenda');
  const meta = questionMeta(question);
  solutionBrief(question, {
    track: meta ? meta.track : null,
    dossier: meta && meta.use_dossier ? selfStudyDossier() : null,
    live: !args.includes('--dry-run'),
  }).then((r) => { log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { log(`error: ${e.message}`); process.exit(1); });
}
