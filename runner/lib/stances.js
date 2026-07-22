'use strict';
/**
 * runner/lib/stances.js — the STANCE registry: committed sides on specific,
 * named, time-bound events, connected to the belief ontology.
 *
 * Axes are dispositions ("Truth and Evidence in Public Discourse" +0.59); a
 * stance is a commitment ("the impeachment of X is justified", "Argentina
 * takes the 2026 World Cup"). Two types:
 *   - "principled": MUST be grounded in ontology axes (grounded_in:
 *     [{axis_id, pole}]) — the side follows from what Sebastian believes.
 *   - "taste": persona picks (sports, culture) — allowed, capped, flagged so
 *     downstream gates never treat them as factual claims.
 *
 * Ontology connection runs BOTH directions:
 *   - formation validates grounded_in axis ids against state/ontology.json
 *   - resolution writes evidence into state/ontology_delta.json (the
 *     sanctioned write path — apply_ontology_delta.js merges and gates it):
 *     a stance that resolved RIGHT is evidence for the pole it was grounded
 *     in; one that resolved WRONG is evidence for the opposite pole. Being
 *     wrong in public literally moves the beliefs that produced the call.
 *
 * A principled stance is an EVENT-SCOPED MINI-AXIS, mirroring the ontology
 * schema: two named poles + a research-derived position in [-1, +1]. The sign
 * is the committed side; the magnitude is how far the verified evidence
 * leans, and drives voice strength downstream (tentatively/clearly/strongly —
 * same scale as axis convictions). confidence_pct stays separate: it is the
 * calibrated probability the RESOLVABLE outcome goes his way ("justified
 * (+0.7) but only 40% likely to succeed" is a valid, honest stance).
 *
 * state/stances.json: { stances: [{ id, event, question, side, type,
 *   pole_a, pole_b, position, grounded_in, confidence_pct, rationale,
 *   resolves_when, research, taken_at, last_checked,
 *   status: "open"|"resolved"|"abandoned", outcome, was_right, resolved_at }] }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..');
const STANCES_PATH = path.join(ROOT, 'state', 'stances.json');
const DELTA_PATH = path.join(ROOT, 'state', 'ontology_delta.json');
const ONTO_PATH = path.join(ROOT, 'state', 'ontology.json');

const MAX_OPEN = 6;
const MAX_OPEN_TASTE = 2;
const MIN_POSITION = 0.15;   // leans weaker than this are declines, not stances
const MAX_REVISIONS = 2;     // a stance may be swayed by new evidence, but rarely — past this, resolve or abandon

function loadStances() {
  try { return JSON.parse(fs.readFileSync(STANCES_PATH, 'utf-8')); } catch { return { stances: [] }; }
}
function saveStances(s) { fs.writeFileSync(STANCES_PATH, JSON.stringify(s, null, 2)); }

function ontologyAxes() {
  try { const o = JSON.parse(fs.readFileSync(ONTO_PATH, 'utf-8')); return Object.values(o.axes || o); }
  catch { return []; }
}

function activeStances() { return loadStances().stances.filter(s => s.status === 'open'); }

function eventKey(e) {
  return String(e || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
}

/**
 * Validate + register a new stance. Principled stances must ground in at
 * least one real ontology axis. Returns { ok, reason?, stance? }.
 */
function addStance(input) {
  const st = loadStances();
  const open = st.stances.filter(s => s.status === 'open');
  const key = eventKey(input.event);
  if (!key) return { ok: false, reason: 'no_event' };
  if (st.stances.some(s => s.status === 'open' && eventKey(s.event) === key)) {
    return { ok: false, reason: 'duplicate_event' };
  }
  if (open.length >= MAX_OPEN) return { ok: false, reason: 'open_cap_reached' };
  const type = input.type === 'taste' ? 'taste' : 'principled';
  if (type === 'taste' && open.filter(s => s.type === 'taste').length >= MAX_OPEN_TASTE) {
    return { ok: false, reason: 'taste_cap_reached' };
  }
  let grounded = [];
  let position = null;
  if (type === 'principled') {
    const ids = new Set(ontologyAxes().map(a => a.id));
    grounded = (Array.isArray(input.grounded_in) ? input.grounded_in : [])
      .filter(g => g && ids.has(g.axis_id) && ['left', 'right'].includes(g.pole));
    if (!grounded.length) return { ok: false, reason: 'no_valid_axis_grounding' };
    // Spectrum: position in [-1, +1] between pole_a (-) and pole_b (+). A lean
    // under the commit floor is not a stance — decline instead of faking a side.
    if (Number.isFinite(+input.position)) {
      position = Math.max(-1, Math.min(1, +input.position));
      if (Math.abs(position) < MIN_POSITION) return { ok: false, reason: 'lean_below_commit_floor' };
    }
  }
  const stance = {
    id: 'stance_' + crypto.createHash('md5').update(key + (input.taken_at || '')).digest('hex').slice(0, 8),
    event: String(input.event).slice(0, 160),
    question: String(input.question || input.event).slice(0, 200),
    side: String(input.side || '').slice(0, 160),
    type,
    pole_a: String(input.pole_a || '').slice(0, 120),
    pole_b: String(input.pole_b || '').slice(0, 120),
    position,
    grounded_in: grounded,
    confidence_pct: Number.isFinite(+input.confidence_pct) ? Math.max(1, Math.min(99, +input.confidence_pct)) : 60,
    rationale: String(input.rationale || '').slice(0, 400),
    resolves_when: String(input.resolves_when || '').slice(0, 160),
    taken_at: input.taken_at || new Date().toISOString().slice(0, 10),
    research: input.research && typeof input.research === 'object'
      ? { confidence_pct: input.research.confidence_pct ?? null, key_finding: String(input.research.key_finding || '').slice(0, 240) }
      : null,
    last_checked: null,
    status: 'open',
    outcome: null,
    was_right: null,
    resolved_at: null,
  };
  st.stances.push(stance);
  st.stances = st.stances.slice(-100);
  saveStances(st);
  return { ok: true, stance };
}

/**
 * Resolve an open stance. For principled stances with a scoreable outcome,
 * feed the result back into the ontology via ontology_delta.json evidence:
 * right → evidence for the grounded pole; wrong → evidence for the opposite.
 */
function resolveStance(id, { outcome, was_right = null, abandoned = false } = {}) {
  const st = loadStances();
  const s = st.stances.find(x => x.id === id && x.status === 'open');
  if (!s) return { ok: false, reason: 'not_found_or_closed' };
  s.status = abandoned ? 'abandoned' : 'resolved';
  s.outcome = String(outcome || '').slice(0, 300);
  s.was_right = was_right;
  s.resolved_at = new Date().toISOString().slice(0, 10);
  saveStances(st);

  if (!abandoned && s.type === 'principled' && typeof was_right === 'boolean' && s.grounded_in.length) {
    try {
      let delta; try { delta = JSON.parse(fs.readFileSync(DELTA_PATH, 'utf-8')); } catch { delta = {}; }
      delta.evidence = Array.isArray(delta.evidence) ? delta.evidence : [];
      for (const g of s.grounded_in) {
        delta.evidence.push({
          axis_id: g.axis_id,
          source: `stance:${s.id}`,
          content: `Stance resolved: "${s.question}" — took side "${s.side}" (${s.confidence_pct}%); outcome: ${s.outcome}; Sebastian was ${was_right ? 'RIGHT' : 'WRONG'}.`,
          timestamp: new Date().toISOString(),
          pole_alignment: was_right ? g.pole : (g.pole === 'left' ? 'right' : 'left'),
        });
      }
      fs.writeFileSync(DELTA_PATH, JSON.stringify(delta, null, 2));
    } catch (e) { console.error(`[stances] ontology feedback failed (non-fatal): ${e.message}`); }
  }
  return { ok: true, stance: s };
}

/**
 * Sway an OPEN stance on new evidence — the honest escape hatch from immutability.
 * A stance holds its line until it resolves, but genuinely disconfirming evidence
 * must have a way to move it rather than forcing the persona to keep repeating a
 * position it no longer believes. This is deliberately COSTLY: it requires a
 * reason, is capped at MAX_REVISIONS, records the full from→to history, and flags
 * material shifts (a side flip or a sign change in position) as needing an explicit
 * public mind-change post — the change is never silent. Identity fields
 * (event/question/grounded_in) are immutable; only position/side/confidence/
 * rationale move. Returns { ok, reason?, stance?, material? }.
 */
function reviseStance(id, { position, side, confidence_pct, rationale, reason, public_post_url } = {}) {
  const st = loadStances();
  const s = st.stances.find(x => x.id === id && x.status === 'open');
  if (!s) return { ok: false, reason: 'not_found_or_closed' };
  if (!String(reason || '').trim()) return { ok: false, reason: 'reason_required' };
  s.revisions = Array.isArray(s.revisions) ? s.revisions : [];
  if (s.revisions.length >= MAX_REVISIONS) return { ok: false, reason: 'revision_cap_reached' };

  const from = { position: s.position, side: s.side, confidence_pct: s.confidence_pct };
  let newPos = s.position;
  if (Number.isFinite(+position)) {
    newPos = Math.max(-1, Math.min(1, +position));
    // A sway that lands inside the commit floor is not a new side — it's a
    // withdrawal. Abandon honestly rather than hold a fake lean.
    if (s.type === 'principled' && Math.abs(newPos) < MIN_POSITION) return { ok: false, reason: 'lean_below_commit_floor_abandon_instead' };
  }
  const newSide = side != null ? String(side).slice(0, 160) : s.side;
  const newConf = Number.isFinite(+confidence_pct) ? Math.max(1, Math.min(99, +confidence_pct)) : s.confidence_pct;

  // Material = the public position actually flipped (side changed, or the lean
  // crossed zero). Cosmetic tweaks (same side, confidence nudge) are not material.
  const material = (newSide !== s.side) ||
    (Number.isFinite(+from.position) && Number.isFinite(+newPos) && Math.sign(from.position) !== Math.sign(newPos) && newPos !== 0);

  s.position = newPos;
  s.side = newSide;
  s.confidence_pct = newConf;
  if (rationale != null) s.rationale = String(rationale).slice(0, 400);
  s.last_checked = new Date().toISOString().slice(0, 10);
  s.revisions.push({
    at: new Date().toISOString(),
    from,
    to: { position: newPos, side: newSide, confidence_pct: newConf },
    reason: String(reason).slice(0, 400),
    material,
    public_post_url: public_post_url ? String(public_post_url).slice(0, 200) : null,
  });
  // A material sway that has not been publicly owned is flagged for the
  // mind-change poster; cleared once a public_post_url is supplied.
  s.needs_public_mind_change = material && !public_post_url;
  saveStances(st);
  return { ok: true, stance: s, material };
}

/**
 * Prompt block of active stances for the composing paths (tweet, reply, quote,
 * convictions). Empty string when no open stances.
 */
function stancesPromptBlock({ max = MAX_OPEN } = {}) {
  const open = activeStances().slice(0, max);
  if (!open.length) return '';
  const axisLabel = (() => {
    const byId = new Map(ontologyAxes().map(a => [a.id, a.label || a.id]));
    return (id) => byId.get(id) || id;
  })();
  const { strengthWord } = require('./convictions');
  const lines = open.map((s) => {
    if (s.type === 'taste') return `- [taste] ${s.event}: ${s.side} (persona pick — never argue this as fact)`;
    const from = s.grounded_in.map((g) => axisLabel(g.axis_id)).join(', ');
    // Spectrum rendering: lean strength shapes the voice — a ±0.2 stance is
    // stated tentatively, a ±0.8 stance flat-out. Odds stay separate.
    if (Number.isFinite(+s.position) && s.pole_a && s.pole_b) {
      const toward = s.position > 0 ? s.pole_b : s.pole_a;
      return `- ${s.event}: I ${strengthWord(s.position)} lean toward "${toward}" (${s.position > 0 ? '+' : ''}${(+s.position).toFixed(2)} on ${s.pole_a} ↔ ${s.pole_b}); odds it resolves my way: ${s.confidence_pct}% — ${s.rationale || 'see beliefs'}${from ? ` [from: ${from}]` : ''}`;
    }
    return `- ${s.event}: ${s.side} (${s.confidence_pct}%) — because ${s.rationale || 'see beliefs'}${from ? ` [from: ${from}]` : ''}`;
  });
  return '── COMMITTED STANCES (sides already taken — hold these lines; never contradict one in passing; changing a side requires an explicit public mind-change post) ──\n' +
    lines.join('\n') + '\n';
}

module.exports = { loadStances, saveStances, activeStances, addStance, resolveStance, reviseStance, stancesPromptBlock, eventKey, MAX_OPEN, MAX_OPEN_TASTE, MIN_POSITION, MAX_REVISIONS };
