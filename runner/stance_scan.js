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
const MAX_RUN_MS = 12 * 60 * 1000;   // resolution checks + one inline deep-research pass
const TODAY = () => new Date().toISOString().slice(0, 10);
const log = (m) => console.log(`[stance_scan] ${m}`);

const cleanJson = (raw) => { const m = String(raw).replace(/```(?:json)?/gi, '').match(/[[{][\s\S]*[}\]]/); return m ? JSON.parse(m[0]) : null; };

function loadJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fb; } }

// The feed digest is an append-only ~500KB firehose, so a raw byte-tail (the old
// .slice(-4000)) skews to whichever RSS batch landed last — routinely TechCrunch
// or Al Jazeera filler — and hides the named PH events that are the actual stance
// material. Build a compact candidate MENU instead: keep only the header + TITLE
// lines from the last ~600 lines (spans many batches/categories) and drop the
// URL/SUMMARY bulk so the window stays wide but token-bounded.
function recentDigestMenu(lines = 600, maxChars = 13000) {
  let raw = '';
  try { raw = fs.readFileSync(config.FEED_DIGEST_PATH, 'utf-8'); } catch { return ''; }
  const kept = raw.split('\n').slice(-lines)
    .filter((l) => /^\s*\[(?:RSS|FB|LinkedIn)[^\]]*\]/.test(l) || /^\s*TITLE:/.test(l));
  return kept.join('\n').slice(-maxChars);
}

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

// ── Pass 2: formation — candidates → deep research → verified commit ─────────
// A stance is a public commitment, so it earns the same evidence bar as
// everything else: principled candidates go through deepResearch (triage,
// source rubric, claim verification via the intelligence pipeline) and only
// commit when the research clears DR gates; the stance's confidence is CAPPED
// by the research confidence. Taste picks (sports/culture) skip research —
// they are flavor, not findings.
const MIN_RESEARCH_CONF = Number(process.env.STANCE_MIN_RESEARCH_CONF || 45);

async function formPass() {
  const open = stances.activeStances();
  if (open.length >= stances.MAX_OPEN) { log(`open cap reached (${open.length}) — no formation`); return; }

  const digest = recentDigestMenu();
  if (!digest.trim()) { log('no feed digest — skipping formation'); return; }

  const ontology = loadJson(path.join(ROOT, 'state', 'ontology.json'), {});
  const vocation = loadJson(path.join(ROOT, 'state', 'vocation.json'), {});
  const convictions = buildConvictions({ ontology, vocation, maxAxes: 10 });

  // Step 1: spot candidate events (cheap — no commitment yet).
  const rawCand = await reason(
`Today is ${TODAY()}. You are Sebastian Hunter's stance scout. From today's feed, list up to 2 CANDIDATE events he might commit a side on — named, time-bound, contested, with a checkable outcome (a vote, verdict, election, match, deadline). Not vague themes. Zero candidates is a fine answer.

${convictions}

── EXISTING OPEN STANCES (do NOT duplicate these events) ──
${open.map((s) => `- ${s.event}: ${s.side}`).join('\n') || '(none)'}

── RECENT FEED (headlines from the last few days — commit only to CURRENT, contested events) ──
${digest}

Types: "principled" (a side could follow from the convictions above — will be deep-researched before committing) or "taste" (sports/culture persona pick — no research needed).
Output ONLY JSON (no fences):
{"candidates":[{"event":"short name","question":"the researchable question that settles which side to take","type":"principled|taste","side_if_taste":"only for taste: the pick"}]}`,
    { maxTokens: 500, tag: 'stance-scout' });

  let candidates = [];
  try { const j = cleanJson(rawCand); candidates = Array.isArray(j && j.candidates) ? j.candidates.slice(0, 2) : []; } catch {}
  if (!candidates.length) { log('formation: no candidate events today'); return; }

  // Taste candidates commit directly (capped inside addStance).
  for (const c of candidates.filter((x) => x.type === 'taste')) {
    const r = stances.addStance({ event: c.event, question: c.question, side: c.side_if_taste || '', type: 'taste' });
    log(r.ok ? `STANCE TAKEN [taste] "${r.stance.event}": ${r.stance.side}` : `taste candidate rejected (${r.reason}): ${String(c.event).slice(0, 60)}`);
  }

  // Step 2: research the top principled candidate with the full DR machinery.
  const cand = candidates.find((x) => x.type !== 'taste');
  if (!cand) return;
  log(`researching candidate: "${cand.event}" — ${String(cand.question).slice(0, 100)}`);
  const { deepResearch } = require('./deep_research');
  const res = await deepResearch(String(cand.question || cand.event), { maxFetch: 3, allowTree: false, maxVerify: 2 });
  if (res.bailed) { log(`candidate underspecified (${res.clarify || 'triage bail'}) — no stance`); return; }
  const a = res.assessment || {};
  if (a.compromised || (a.confidence_pct != null && a.confidence_pct < MIN_RESEARCH_CONF)) {
    log(`evidence too weak to commit (confidence=${a.confidence_pct != null ? a.confidence_pct + '%' : '?'}${a.compromised ? ', compromised' : ''}) — no stance`);
    return;
  }

  // Step 3: commit decision, grounded in convictions + the verified research.
  const axes = Object.values(ontology.axes || ontology || {})
    .filter((x) => x && x.id)
    .sort((x, y) => ((y.confidence || 0) * Math.abs(y.score || 0)) - ((x.confidence || 0) * Math.abs(x.score || 0)))
    .slice(0, 20)
    .map((x) => `${x.id} — "${x.label}" (left="${(x.left_pole || '').slice(0, 60)}", right="${(x.right_pole || '').slice(0, 60)}")`)
    .join('\n');
  const rawCommit = await reason(
`Today is ${TODAY()}. You are Sebastian Hunter placing his STANCE on "${cand.event}" after researching it. A stance is a position on a SPECTRUM between two poles — the sign is the side he argues publicly, the magnitude is how far the verified evidence leans (it shapes how forcefully he states it). He holds it consistently and is scored when the event resolves.

${convictions}

── RESEARCH (verified — confidence ${a.confidence_pct != null ? a.confidence_pct + '%' : 'unstated'}; key finding: ${a.key_finding || '(none)'}) ──
${String(res.report).slice(0, 2500)}

── AXES AVAILABLE FOR GROUNDING (exact axis_id; pole = which pole the position follows from) ──
${axes}

Define the spectrum and place the position:
- pole_a (negative end) and pole_b (positive end): the two opposing resolutions of the question, in plain words.
- position in [-1,+1]: where the RESEARCHED EVIDENCE + convictions actually land — NOT how strongly he wishes. ±0.2 = tentative lean, ±0.5 = clear, ±0.8 = strong. If the honest position is inside ±0.15, DECLINE — a fake side is worse than none.
- confidence_pct: the separate, calibrated probability the RESOLVABLE outcome lands on his side of the spectrum — must NOT exceed the research confidence. ("justified (+0.7) but only 40% likely to succeed" is a valid honest stance.)

Output ONLY JSON (no fences):
{"commit":false,"why":"one line"} OR {"commit":true,"pole_a":"...","pole_b":"...","position":0.6,"side":"the side he argues (matches the position's sign)","grounded_in":[{"axis_id":"...","pole":"left|right"}],"confidence_pct":55,"rationale":"one sentence in Sebastian's voice citing the key evidence","resolves_when":"date or condition"}`,
    { maxTokens: 600, tag: 'stance-commit' });

  let d = null;
  try { d = cleanJson(rawCommit); } catch {}
  if (!d || !d.commit) { log(`declined to commit on "${cand.event}" after research${d && d.why ? ` — ${String(d.why).slice(0, 100)}` : ''}`); return; }
  const cappedConf = a.confidence_pct != null ? Math.min(+d.confidence_pct || 60, a.confidence_pct) : (+d.confidence_pct || 60);
  const r = stances.addStance({
    event: cand.event,
    question: cand.question,
    side: d.side,
    type: 'principled',
    pole_a: d.pole_a,
    pole_b: d.pole_b,
    position: d.position,
    grounded_in: d.grounded_in,
    confidence_pct: cappedConf,
    rationale: d.rationale,
    resolves_when: d.resolves_when,
    research: { confidence_pct: a.confidence_pct, key_finding: a.key_finding },
  });
  if (r.ok) log(`STANCE TAKEN [principled, researched ${a.confidence_pct != null ? a.confidence_pct + '%' : '?'}] "${r.stance.event}": position ${r.stance.position != null ? (r.stance.position > 0 ? '+' : '') + r.stance.position.toFixed(2) : '?'} → ${r.stance.side} (odds ${r.stance.confidence_pct}%)`);
  else log(`stance rejected (${r.reason}): ${String(cand.event).slice(0, 60)}`);
}

const killer = setTimeout(() => { log(`exceeded ${MAX_RUN_MS / 60000} min — aborting`); process.exit(1); }, MAX_RUN_MS);

(async () => {
  await resolvePass();
  await formPass();
})()
  .then(() => { clearTimeout(killer); process.exit(0); })
  .catch((e) => { log(`error (non-fatal): ${e.message}`); clearTimeout(killer); process.exit(0); });
