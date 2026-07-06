'use strict';
/**
 * runner/lib/outbound_gates.js — the shared gate pipeline every outbound surface
 * passes through before publishing (X tweet/quote/reply/thread, LinkedIn
 * post/comment, and any future channel — Mastodon, Bluesky, Threads, …).
 *
 * Before this module, gating was inconsistent per surface: some paths ran
 * voice_filter but no fact-check, others fact-checked but skipped voice_filter,
 * and the fact-check prompt was copy-pasted in three files. This centralizes it
 * so "what must be true before Sebastian says something in public" lives in ONE
 * place and every channel — including ones added later — passes the same bar.
 *
 *   passOutbound(text, opts) → { ok, text, reason }
 *       Runs the requested gates in order, threading corrected text through.
 *       Channel-agnostic: a new surface just calls this with its gate list.
 *   factCheck(text, opts)    → { pass, text, reason }   (used standalone too)
 *   voiceGate(text)          → { pass, issues }
 *
 * Gates:
 *   'voice'     — voice_filter.check (banned phrases / off-voice tics)
 *   'factcheck' — verifiably-wrong-fact pass (stale officeholder titles, datable
 *                 claims); corrects when possible, else rejects. Fails OPEN on
 *                 LLM/parse error so an outage never blocks posting.
 *
 * The fact-check composes via lib/compose.js, so it runs on the Claude terminal
 * when COMPOSE_BACKEND=claude (else the local/Vertex brain).
 */

const voiceFilter = require('./voice_filter');
const { compose } = require('./compose');

/** voiceGate(text) → { pass, issues } — never throws. */
function voiceGate(text) {
  try {
    const issues = voiceFilter.check(text) || [];
    return { pass: issues.length === 0, issues };
  } catch {
    return { pass: true, issues: [] };
  }
}

/**
 * factCheck(text, opts) → { pass, text, reason }
 * Flags verifiably-wrong facts; returns a corrected `text` when the checker can
 * fix it, rejects (pass:false) when it can't. Fails OPEN (pass:true) on error.
 * opts.maxLen — reject a correction that exceeds this length.
 * opts.tag    — log/label prefix.
 */
async function factCheck(text, { tag = 'gate', maxLen = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = await compose(
      `Today is ${today}. Review this social post for verifiably wrong facts — a wrong ` +
      `CURRENT officeholder title, or a datable fact clearly wrong given today. Do NOT ` +
      `flag opinion, analysis, interpretation, or merely-uncertain claims; do NOT flag a ` +
      `person's name used without a title; do NOT flag past-tense history. Reply with JSON ` +
      `only: {"pass":true} OR {"pass":false,"corrected":"full corrected text, or null if ` +
      `not fixable"}.\n\nPOST:\n"""\n${text}\n"""`,
      { maxTokens: 1200, tag: `${tag}:factcheck` }
    );
    const cleaned = String(raw).replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
    const m = cleaned.match(/\{[\s\S]*\}/);
    const res = m ? JSON.parse(m[0]) : { pass: true };
    if (res.pass === false) {
      const corrected = (res.corrected || '').trim();
      if (corrected && corrected.toLowerCase() !== 'null' && (!maxLen || corrected.length <= maxLen)) {
        return { pass: true, text: corrected, reason: 'corrected' };
      }
      return { pass: false, text, reason: 'unfixable factual error' };
    }
    return { pass: true, text, reason: 'ok' };
  } catch (e) {
    return { pass: true, text, reason: `factcheck-skipped (${e.message})` }; // fail open
  }
}

/**
 * passOutbound(text, opts) → { ok, text, reason }
 * The one gate every surface calls. Runs gates in order; on the first failure
 * returns { ok:false, reason }. A passing fact-check may replace `text` with a
 * corrected version, so callers should publish the RETURNED text.
 *
 * opts.gates  — subset of ['voice','factcheck'] (default: both)
 * opts.maxLen — hard length cap (reject if exceeded; also bounds fact-check fixes)
 * opts.tag    — log label
 */
async function passOutbound(text, { gates = ['voice', 'factcheck'], maxLen = null, tag = 'gate' } = {}) {
  let out = (text || '').trim().replace(/^["']|["']$/g, '');
  if (!out || out.toUpperCase() === 'SKIP') return { ok: false, text: out, reason: 'empty/SKIP' };
  if (maxLen && out.length > maxLen) return { ok: false, text: out, reason: `too long (${out.length}>${maxLen})` };

  if (gates.includes('voice')) {
    const v = voiceGate(out);
    if (!v.pass) return { ok: false, text: out, reason: `voice_filter: ${v.issues.join('; ')}` };
  }
  if (gates.includes('factcheck')) {
    const f = await factCheck(out, { tag, maxLen });
    if (!f.pass) return { ok: false, text: out, reason: f.reason };
    out = f.text;
  }
  return { ok: true, text: out, reason: 'pass' };
}

module.exports = { passOutbound, factCheck, voiceGate };
