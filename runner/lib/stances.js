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
 * state/stances.json: { stances: [{ id, event, question, side, type,
 *   grounded_in, confidence_pct, rationale, resolves_when, taken_at,
 *   last_checked, status: "open"|"resolved"|"abandoned", outcome, was_right,
 *   resolved_at }] }
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
  if (type === 'principled') {
    const ids = new Set(ontologyAxes().map(a => a.id));
    grounded = (Array.isArray(input.grounded_in) ? input.grounded_in : [])
      .filter(g => g && ids.has(g.axis_id) && ['left', 'right'].includes(g.pole));
    if (!grounded.length) return { ok: false, reason: 'no_valid_axis_grounding' };
  }
  const stance = {
    id: 'stance_' + crypto.createHash('md5').update(key + (input.taken_at || '')).digest('hex').slice(0, 8),
    event: String(input.event).slice(0, 160),
    question: String(input.question || input.event).slice(0, 200),
    side: String(input.side || '').slice(0, 160),
    type,
    grounded_in: grounded,
    confidence_pct: Number.isFinite(+input.confidence_pct) ? Math.max(1, Math.min(99, +input.confidence_pct)) : 60,
    rationale: String(input.rationale || '').slice(0, 400),
    resolves_when: String(input.resolves_when || '').slice(0, 160),
    taken_at: input.taken_at || new Date().toISOString().slice(0, 10),
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
 * Prompt block of active stances for the composing paths (tweet, reply,
 * convictions). Empty string when no open stances.
 */
function stancesPromptBlock({ max = MAX_OPEN } = {}) {
  const open = activeStances().slice(0, max);
  if (!open.length) return '';
  const axisLabel = (() => {
    const byId = new Map(ontologyAxes().map(a => [a.id, a.label || a.id]));
    return (id) => byId.get(id) || id;
  })();
  const lines = open.map((s) => {
    if (s.type === 'taste') return `- [taste] ${s.event}: ${s.side} (persona pick — never argue this as fact)`;
    const from = s.grounded_in.map((g) => axisLabel(g.axis_id)).join(', ');
    return `- ${s.event}: ${s.side} (${s.confidence_pct}%) — because ${s.rationale || 'see beliefs'}${from ? ` [from: ${from}]` : ''}`;
  });
  return '── COMMITTED STANCES (sides already taken — hold these lines; never contradict one in passing; changing a side requires an explicit public mind-change post) ──\n' +
    lines.join('\n') + '\n';
}

module.exports = { loadStances, saveStances, activeStances, addStance, resolveStance, stancesPromptBlock, eventKey, MAX_OPEN, MAX_OPEN_TASTE };
