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
      `CURRENT officeholder title, a person portrayed as performing an official act they no ` +
      `longer hold the office for, or a datable fact clearly wrong given today. A bare name ` +
      `with a present-tense official act ("X vows retaliation", "X orders strikes", "X signs ` +
      `the bill") IS an officeholder claim — check it against who actually holds that office ` +
      `today, even with no title attached. (Real example this gate wrongly passed: "Biden vows ` +
      `retaliation" on a 2026 attack — Biden was not president.) Do NOT flag opinion, analysis, ` +
      `interpretation, or merely-uncertain claims; do NOT flag a name used in a non-official or ` +
      `historical context; do NOT flag past-tense history. Reply with JSON ` +
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
 * coherenceGate(text, source, opts) → { pass, why }
 * Is the output coherent against the thing it responds to? The specific failure
 * this catches is an INVENTED CONTRADICTION: a reply implying the source is
 * wrong/misleading when the source never claimed the thing being "corrected".
 * Real case — a post reporting "US soldier killed in an Iranian attack on a base
 * IN Jordan" drew "the post says Jordan but we're hitting Iran daily", which the
 * fact-check gate passed because that tangential claim was independently true.
 *
 * The mechanism is a CITATION REQUIREMENT, not a vibe check: if the reply implies
 * the source is wrong, the judge must QUOTE the sentence being contradicted. No
 * quotable sentence means the contradiction was invented, so the reply is
 * incoherent. Making the verdict falsifiable is what made it stable — an earlier
 * "did it understand the post?" phrasing passed the case above on every attempt
 * across three rewordings, while this flags it on every attempt and still passes
 * accurate replies AND substantive disagreement (9/9 in testing).
 *
 * Uses reason() (strict reasoning system prompt), not compose() (voice framing).
 * Fails OPEN on any error/unparseable output.
 */
async function coherenceGate(text, source, { tag = 'gate' } = {}) {
  try {
    const { reason } = require('./compose');
    const raw = await reason(
      `You are checking a REPLY for coherence against the POST it answers.\n\n` +
      `POST:\n"${String(source).slice(0, 800)}"\n\n` +
      `REPLY:\n"${text}"\n\n` +
      `Step 1. Does the reply assert or IMPLY that the post is wrong, misleading, incomplete, or ` +
      `self-contradictory? (Words like "but", "actually", "says X yet Y" usually signal this.)\n` +
      `Step 2. If YES, you must QUOTE the exact sentence from the POST that the reply contradicts. ` +
      `If no such sentence exists in the POST, the reply is inventing a contradiction — that is ` +
      `INCOHERENT.\n` +
      `Step 3. If the reply merely adds context, agrees, or disagrees with the post's substance ` +
      `WITHOUT implying the post misstated something, it is COHERENT.\n\n` +
      `Output ONLY JSON: {"implies_post_is_wrong": true, "quote_from_post": "exact sentence or empty", "coherent": true, "why": "one short line"}`,
      { maxTokens: 300, tag: `${tag}:coherence` }
    );
    const cleaned = String(raw).replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
    const m = cleaned.match(/\{[\s\S]*\}/);
    const res = m ? JSON.parse(m[0]) : null;
    if (!res || typeof res.coherent !== 'boolean') return { pass: true, why: 'coherence-skipped (unparseable)' };
    return { pass: res.coherent, why: String(res.why || '').slice(0, 160) };
  } catch (e) {
    return { pass: true, why: `coherence-skipped (${e.message})` }; // fail open
  }
}

/**
 * passOutbound(text, opts) → { ok, text, reason, coherence? }
 * The one gate every surface calls. Runs gates in order; on the first failure
 * returns { ok:false, reason }. A passing fact-check may replace `text` with a
 * corrected version, so callers should publish the RETURNED text.
 *
 * opts.gates  — subset of ['voice','factcheck'] (default: both)
 * opts.maxLen — hard length cap (reject if exceeded; also bounds fact-check fixes)
 * opts.tag    — log label
 * opts.source — the post/comment being responded to. Supplying it enables the
 *               coherence gate (skipped entirely when absent, e.g. original
 *               tweets, which have nothing to comprehend).
 * opts.regenerate — optional async (why) => newText. On a coherence miss the
 *               caller is asked to re-draft with the specific correction and the
 *               full gate chain re-runs on the new text (bounded by attempts).
 *
 * NEVER blocks on coherence: with a regenerate callback a miss becomes a
 * re-draft; without one (or if still unresolved) the text passes with
 * `coherence:{ok:false,why}` attached and a logged marker. All output goes
 * through — the gate steers accuracy, it does not withhold.
 */
async function passOutbound(text, { gates = ['voice', 'factcheck'], maxLen = null, tag = 'gate', source = null, regenerate = null, coherenceAttempts = 2 } = {}) {
  let coherence = null;

  for (let attempt = 1; attempt <= Math.max(1, coherenceAttempts); attempt++) {
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

    if (!source) return { ok: true, text: out, reason: 'pass' };   // nothing to comprehend

    const c = await coherenceGate(out, source, { tag });
    if (c.pass) return { ok: true, text: out, reason: 'pass' };
    coherence = { ok: false, why: c.why };

    // Miss: ask the caller to re-draft with the correction, then re-gate.
    if (regenerate && attempt < Math.max(1, coherenceAttempts)) {
      console.log(`[${tag}] coherence miss (attempt ${attempt}): ${c.why} — regenerating`);
      let redraft = null;
      try { redraft = await regenerate(c.why); } catch (e) { console.log(`[${tag}] regenerate failed: ${e.message}`); }
      if (redraft && String(redraft).trim()) { text = redraft; continue; }
    }
    // No regenerate hook, or it gave nothing back: pass the text through anyway
    // (directive: all output goes through) but leave a loud marker for review.
    console.log(`[${tag}] coherence unresolved — publishing anyway (fail-open): ${c.why}`);
    return { ok: true, text: out, reason: 'pass (coherence unresolved)', coherence };
  }

  return { ok: true, text: (text || '').trim(), reason: 'pass (coherence unresolved)', coherence };
}

module.exports = { passOutbound, factCheck, voiceGate, coherenceGate };
