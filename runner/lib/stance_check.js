'use strict';
/**
 * runner/lib/stance_check.js — does an outbound line argue the side he committed to?
 *
 * Extracted from the retired lib/local_harness.js (which existed to make a weak
 * local model safe to publish from). The harness went with the local backend;
 * this check did NOT, because the failure it catches was never local:
 *
 *   2026-07-25 — "I believe in open borders" was composed by CLAUDE on an axis
 *   scored 0.87 toward NATIONAL CONTROL, and passed voice_filter + factcheck
 *   untouched. Those gates check tics and officeholder facts; neither can see a
 *   reversed position.
 *
 * Bounded single-letter classification, the shape that stays reliable and cheap.
 * Runs on Claude (runner/llm.js INFERENCE POLICY — the only backend there is).
 *
 * FAILS OPEN by returning a reason string only on a POSITIVE finding; callers
 * decide whether an unverifiable check blocks. stance_video treats "cannot
 * verify" as not-blocking so an outage does not silence the daily series.
 */

/**
 * @param {string} text   the generated line
 * @param {object} axis   { poleA, poleB, score } — score in -1..+1 toward poleB
 * @returns {Promise<string|null>} reason on mismatch, null when consistent
 */
async function checkStance(text, axis) {
  if (!axis || typeof axis.score !== 'number') return null;
  const prompt =
    `Which side does this statement take?\n\n` +
    `A = ${axis.poleA}\nB = ${axis.poleB}\n\n` +
    `STATEMENT: "${String(text).slice(0, 400)}"\n\n` +
    `Answer with a SINGLE letter, A or B. If it takes neither side, answer N.\nLetter:`;

  let letter;
  try {
    const { generate } = require('../llm');
    // 90s: inference is the Claude CLI (a subprocess) and cannot answer faster
    // under load. One call per stance video — a daily series — so this is cheap.
    const raw = await generate(prompt, { temperature: 0, maxTokens: 3, timeoutMs: 90_000, tag: 'stance_check' });
    const m = String(raw).match(/[ABNabn]/);
    letter = m ? m[0].toUpperCase() : null;
  } catch (e) {
    return `stance check unavailable (${e.message})`;
  }

  if (!letter) return 'stance check returned no verdict';
  if (letter === 'N') return 'output takes no clear side, but a committed stance was required';
  const expected = axis.score >= 0 ? 'B' : 'A';
  if (letter !== expected) {
    return `STANCE INVERTED: output argues "${letter === 'A' ? axis.poleA : axis.poleB}" but the committed position (score ${axis.score}) is "${expected === 'A' ? axis.poleA : axis.poleB}"`;
  }
  return null;
}

module.exports = { checkStance };
