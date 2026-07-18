#!/usr/bin/env node
'use strict';
/**
 * runner/stance_scan.js — daily stance formation + resolution.
 *
 * Two passes over the stance registry (lib/stances):
 *   1. RESOLVE — for up to 2 open stances (oldest last_checked first), web
 *      search the event's outcome and adjudicate: resolved (with was_right
 *      where scoreable) or still open. Resolution feeds the belief ontology
 *      via lib/stances → ontology_delta.json.
 *   2. FORM — from the feed digest + Sebastian's convictions, propose 0-2 NEW
 *      stances on named, time-bound, contested events. Principled stances must
 *      ground in real ontology axes (validated by addStance); taste stances
 *      (sports/culture) are capped at 2.
 *
 * Invoked daily from the orchestrator, detached (searches + reason() calls run
 * ~1-3 min). Non-fatal: exits 0 on any error. Gate: STANCE_SCAN_ENABLED != 0.
 */

const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const { reason } = require('./lib/compose');
const { searchWeb } = require('./lib/helmstack_fetch');
const { buildConvictions } = require('./lib/convictions');
const stances = require('./lib/stances');

const ROOT = path.resolve(__dirname, '..');
const MAX_RUN_MS = 8 * 60 * 1000;
const TODAY = () => new Date().toISOString().slice(0, 10);
const log = (m) => console.log(`[stance_scan] ${m}`);

const cleanJson = (raw) => { const m = String(raw).replace(/```(?:json)?/gi, '').match(/[[{][\s\S]*[}\]]/); return m ? JSON.parse(m[0]) : null; };

function loadJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; } }

// ── Pass 1: resolution ────────────────────────────────────────────────────────
async function resolvePass() {
  const open = stances.activeStances()
    .sort((a, b) => String(a.last_checked || '').localeCompare(String(b.last_checked || '')))
    .slice(0, 2);
  for (const s of open) {
    log(`checking: "${s.event}"`);
    let results = [];
    try { results = await searchWeb(`${s.event} outcome result ${TODAY().slice(0, 4)}`, { max: 5 }); } catch {}
    const evidence = (results || []).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n') || '(no results)';
    try {
      const raw = await reason(
`Today is ${TODAY()}. Has this event concluded, and if so how did Sebastian's stance fare?

STANCE: on "${s.event}" — question: "${s.question}" — side taken: "${s.side}" (${s.confidence_pct}%), taken ${s.taken_at}. Resolves when: ${s.resolves_when || '(unspecified)'}.

WEB SEARCH RESULTS:
${evidence.slice(0, 2500)}

Judge strictly from the results — do not guess. "was_right" only when the outcome clearly settles the question (true/false); null if resolved but not scoreable.
Output ONLY JSON: {"resolved":false} OR {"resolved":true,"outcome":"one sentence, concrete","was_right":true|false|null}`,
        { maxTokens: 300, tag: 'stance-resolve' });
      const j = cleanJson(raw);
      if (j && j.resolved) {
        const r = stances.resolveStance(s.id, { outcome: j.outcome, was_right: typeof j.was_right === 'boolean' ? j.was_right : null });
        log(`RESOLVED "${s.event}" → ${j.outcome} (${j.was_right === true ? 'was RIGHT' : j.was_right === false ? 'was WRONG' : 'unscored'})${r.ok && s.type === 'principled' ? ' — ontology delta written' : ''}`);
        continue;
      }
    } catch (e) { log(`resolve check failed (non-fatal): ${e.message}`); }
    // still open — stamp last_checked
    const st = stances.loadStances();
    const row = st.stances.find(x => x.id === s.id);
    if (row) { row.last_checked = TODAY(); stances.saveStances(st); }
  }
}

// ── Pass 2: formation ─────────────────────────────────────────────────────────
async function formPass() {
  const open = stances.activeStances();
  if (open.length >= stances.MAX_OPEN) { log(`open cap reached (${open.length}) — no formation`); return; }

  let digest = '';
  try { digest = fs.readFileSync(config.FEED_DIGEST_PATH, 'utf-8').slice(-4000); } catch {}
  if (!digest.trim()) { log('no feed digest — skipping formation'); return; }

  const ontology = loadJson(path.join(ROOT, 'state', 'ontology.json'), {});
  const vocation = loadJson(path.join(ROOT, 'state', 'vocation.json'), {});
  const convictions = buildConvictions({ ontology, vocation, maxAxes: 10 });
  const axes = Object.values(ontology.axes || ontology || {})
    .filter((a) => a && a.id)
    .sort((a, b) => ((b.confidence || 0) * Math.abs(b.score || 0)) - ((a.confidence || 0) * Math.abs(a.score || 0)))
    .slice(0, 20)
    .map((a) => `${a.id} — "${a.label}" (lean: ${a.score > 0 ? 'right' : a.score < 0 ? 'left' : 'neutral'}; left="${(a.left_pole || '').slice(0, 60)}", right="${(a.right_pole || '').slice(0, 60)}")`)
    .join('\n');

  const raw = await reason(
`Today is ${TODAY()}. You are Sebastian Hunter deciding whether to COMMIT to a side on any live, named, time-bound contested event visible in today's feed. A stance is a public commitment he will hold consistently and be scored on when the event resolves — take one only when his beliefs (or persona taste) genuinely ground a side.

${convictions}

── EXISTING OPEN STANCES (do NOT duplicate these events) ──
${open.map((s) => `- ${s.event}: ${s.side}`).join('\n') || '(none)'}

── TODAY'S FEED DIGEST ──
${digest}

── AXES AVAILABLE FOR GROUNDING (use exact axis_id; pole = which pole the SIDE follows from) ──
${axes}

Rules:
- 0-2 stances. Zero is a fine answer — most days have nothing worth committing to.
- The event must be NAMED and TIME-BOUND with a checkable outcome (a vote, verdict, election, match, deadline) — not a vague theme.
- "principled": the side must follow from the convictions above; cite 1-2 grounding axes with the pole it follows from.
- "taste": sports/culture picks with no belief grounding — allowed, sparing, clearly flavor.
- confidence_pct is the honest probability the side proves right — Sebastian's record is scored against it.

Output ONLY JSON (no fences):
{"stances":[{"event":"short name","question":"what will be settled","side":"the committed side","type":"principled|taste","grounded_in":[{"axis_id":"...","pole":"left|right"}],"confidence_pct":60,"rationale":"one sentence in Sebastian's voice","resolves_when":"date or condition"}]}`,
    { maxTokens: 800, tag: 'stance-form' });

  let proposed = [];
  try { const j = cleanJson(raw); proposed = Array.isArray(j && j.stances) ? j.stances.slice(0, 2) : []; } catch {}
  if (!proposed.length) { log('formation: nothing worth committing to today'); return; }
  for (const p of proposed) {
    const r = stances.addStance(p);
    if (r.ok) log(`STANCE TAKEN [${r.stance.type}] "${r.stance.event}": ${r.stance.side} (${r.stance.confidence_pct}%)`);
    else log(`stance rejected (${r.reason}): ${String(p.event).slice(0, 60)}`);
  }
}

const killer = setTimeout(() => { log(`exceeded ${MAX_RUN_MS / 60000} min — aborting`); process.exit(1); }, MAX_RUN_MS);

(async () => {
  await resolvePass();
  await formPass();
})()
  .then(() => { clearTimeout(killer); process.exit(0); })
  .catch((e) => { log(`error (non-fatal): ${e.message}`); clearTimeout(killer); process.exit(0); });
