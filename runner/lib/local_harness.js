'use strict';
/**
 * runner/lib/local_harness.js — make a weak local model safe to publish from.
 *
 * A small model can be trusted to CLASSIFY but not to GENERATE. That asymmetry
 * is measured, not assumed (phi4-mini, 2026-08-19, Sebastian's real prompts):
 *
 *   classification — correctly zeroed birthdays, job posts, ads, product news
 *                    on 18 real feed items. Reliable.
 *   generation     — inverted a committed stance ("I staunchly advocate for open
 *                    borders" on an axis scored 0.87 toward NATIONAL CONTROL),
 *                    wrote non-Tagalog ('nakaseptyo', Cebuano 'unya'), rendered
 *                    ₱50,000 as $50,000, invented a $130,000 total, and emitted
 *                    hashtags immediately after "No hashtags".
 *
 * Every one of those passed `voice_filter.check()`, which is regex over banned
 * phrases and cannot see an inverted stance or a currency error. So this module
 * exists to close that gap: generate, then VERIFY with checks that either need
 * no model at all, or use the model only for the bounded yes/no judgements it
 * handles well — and FAIL CLOSED when verification does not pass.
 *
 * Design rules:
 *   1. Deterministic checks first. They are free and cannot themselves be wrong
 *      in the way the model is.
 *   2. Model-based checks are BOUNDED (single token / single digit), never open
 *      prose. Same shape as the relevance scorer that works.
 *   3. Bounded corrective retries, then give up. Returning nothing is a correct
 *      outcome — silence beats publishing an inverted stance under his name.
 *   4. No escalation to Claude. Callers decide backends; this only guards the
 *      local path (chaining backends per call caused the 2026-07-30 cascade).
 */

const { generateLocal } = require('./local_llm');

/** Whether Taglish output is permitted on the local backend (see compose.js). */
function taglishEnabled() {
  try { return require('./compose').localTaglishAllowed(); }
  catch { return false; }
}

// ── Deterministic checks ─────────────────────────────────────────────────────

/** Currency/number drift vs the source text — catches ₱50,000 → $50,000. */
function checkCurrency(text, source) {
  if (!source) return null;
  const srcPeso = /(?:₱|\bP(?=\s?[\d,]))/i.test(source);
  const outDollar = /\$\s?[\d,]/.test(text);
  if (srcPeso && outDollar) return 'currency drift: source is in pesos, output uses "$"';
  return null;
}

/** Numbers in the output that appear nowhere in the source — catches invented totals. */
function checkInventedNumbers(text, source) {
  if (!source) return null;
  const norm = (s) => String(s).replace(/[,\s]/g, '');
  const srcNums = new Set((source.match(/\d[\d,]*/g) || []).map(norm));
  const outNums = (text.match(/\d[\d,]*/g) || []).map(norm).filter((n) => n.length >= 4);
  const invented = outNums.filter((n) => !srcNums.has(n));
  return invented.length ? `invented figure(s) not in source: ${invented.join(', ')}` : null;
}

/** Explicit format constraints the prompt asked for. */
function checkConstraints(text, { maxLen, noHashtags, noEmoji } = {}) {
  const out = [];
  if (maxLen && text.length > maxLen) out.push(`too long: ${text.length} > ${maxLen}`);
  if (noHashtags && /#\w/.test(text)) out.push(`hashtags present despite "no hashtags": ${(text.match(/#\w+/g) || []).join(' ')}`);
  if (noEmoji && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) out.push('emoji present despite "no emoji"');
  if (/\bas an AI\b/i.test(text)) out.push('contains "as an AI"');
  return out.length ? out.join('; ') : null;
}

/**
 * Specificity: the output must carry at least one concrete anchor from the
 * source (a proper noun or a number). Catches the generic-filler failure
 * ("collaboration between tech companies and regulatory bodies…").
 */
function checkSpecificity(text, source) {
  if (!source) return null;
  const anchors = [
    ...(source.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?/g) || []),
    ...(source.match(/\d[\d,]{2,}/g) || []),
  ];
  if (!anchors.length) return null;
  const hit = anchors.some((a) => text.includes(a));
  return hit ? null : 'no concrete anchor from the source (no shared proper noun or figure)';
}

/**
 * Cebuano/Bisaya markers that are NOT Tagalog. phi4-mini emitted 'unya' and
 * 'sa-diri' while asked for Taglish. Cheap, high-precision signal that the
 * model has drifted out of the requested language.
 */
const NON_TAGALOG = /\b(unya|karon|dili|kaayo|nimo|nimu|siya\s+nga|sa-diri|ug|pag-abot|gyud|jud)\b/i;

const TAGALOG_WORDS = /\b(yung|ang|mga|hindi|walang|kasi|pero|naman|dapat|talaga|lang|nag|may|para|habang|ito|sila|natin|ako|niya|kung|nila|ngayon|wala)\b/i;

function checkTaglish(text) {
  const bad = text.match(NON_TAGALOG);
  if (bad) return `non-Tagalog (Cebuano) token: "${bad[0]}"`;
  // Must actually contain some Tagalog if Taglish was requested.
  return TAGALOG_WORDS.test(text) ? null : 'Taglish requested but output has no Tagalog function words';
}

/**
 * The inverse, for when Taglish is DISABLED on this backend
 * (compose.localTaglishAllowed() === false): the model was told English only,
 * so any Tagalog is a violation of the override rather than a style choice.
 *
 * Deliberately keyed on Tagalog *function words*, not on Filipino proper nouns —
 * "Sara Duterte", "Malacañang" and "Bulacan" are correct in English copy and
 * must not trip this.
 */
function checkEnglishOnly(text) {
  const t = text.match(TAGALOG_WORDS);
  if (t) return `English-only required on this backend, but output contains Tagalog: "${t[0]}"`;
  const c = text.match(NON_TAGALOG);
  if (c) return `English-only required, but output contains Cebuano: "${c[0]}"`;
  return null;
}

// ── Model-based checks (BOUNDED output only) ─────────────────────────────────

/**
 * Ask the model to classify its OWN output's stance, then compare to the
 * position actually committed to. This is the check that catches the inversion,
 * and it works because rating a finished sentence is classification — the thing
 * the model does well — not generation.
 *
 * @param {string} text      the generated line
 * @param {object} axis      { poleA, poleB, score }  score in -1..+1 toward poleB
 * @returns {Promise<string|null>} reason on mismatch
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
    const raw = await generateLocal(prompt, { maxTokens: 3, temperature: 0, timeoutMs: 20_000, tag: 'stance_check', stop: ['\n'] });
    const m = String(raw).match(/[ABNabn]/);
    letter = m ? m[0].toUpperCase() : null;
  } catch (e) {
    // Cannot verify => cannot publish. Fail CLOSED.
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

// ── The wrapper ──────────────────────────────────────────────────────────────

/**
 * guardedCompose(prompt, opts) → { ok, text, reason, attempts, checks }
 *
 * Generates on the local model, verifies, and retries with corrective feedback.
 * FAILS CLOSED: if verification never passes, `ok` is false and `text` is null.
 *
 * opts:
 *   source       origin text to ground against (post being replied to, event brief)
 *   axis         { poleA, poleB, score } to enforce stance consistency
 *   maxLen       hard length cap
 *   noHashtags   reject hashtags (default true — every outbound prompt bans them)
 *   noEmoji      reject emoji (default true)
 *   taglish      true if Taglish was requested (enables language checks)
 *   attempts     max generation attempts (default 3)
 */
async function guardedCompose(prompt, opts = {}) {
  const {
    source = null, axis = null, maxLen = null,
    noHashtags = true, noEmoji = true, taglish = false,
    attempts = 3, tag = 'guarded', ...genOpts
  } = opts;

  const checksRun = [];
  let lastReason = 'no attempt made';

  for (let i = 1; i <= attempts; i++) {
    let text;
    try {
      text = await generateLocal(
        i === 1 ? prompt : `${prompt}\n\nYour previous attempt was REJECTED: ${lastReason}\nFix exactly that and return only the corrected text.`,
        { maxTokens: 400, temperature: 0.6, timeoutMs: 120_000, tag, ...genOpts }
      );
    } catch (e) {
      lastReason = `generation failed: ${e.message}`;
      continue;
    }
    text = String(text).trim().replace(/^["']|["']$/g, '');

    // Deterministic first — free, and cannot be wrong the way the model is.
    const det =
      checkConstraints(text, { maxLen, noHashtags, noEmoji }) ||
      checkCurrency(text, source) ||
      checkInventedNumbers(text, source) ||
      checkSpecificity(text, source) ||
      // Language: enforce whichever policy is actually in force. If Taglish is
      // disabled on this backend the override wins regardless of what the caller
      // asked for — a caller requesting Taglish from a model that cannot write
      // it is exactly the case this exists to stop.
      (taglishEnabled() ? (taglish ? checkTaglish(text) : null) : checkEnglishOnly(text));
    if (det) { lastReason = det; checksRun.push({ attempt: i, failed: det }); continue; }

    // Then the voice regex the rest of the system already trusts.
    try {
      const issues = require('./voice_filter').check(text) || [];
      if (issues.length) { lastReason = `voice: ${issues.join('; ')}`; checksRun.push({ attempt: i, failed: lastReason }); continue; }
    } catch { /* voice filter unavailable — not a reason to block */ }

    // Bounded model check last (it costs an inference call).
    const stance = await checkStance(text, axis);
    if (stance) { lastReason = stance; checksRun.push({ attempt: i, failed: stance }); continue; }

    return { ok: true, text, reason: null, attempts: i, checks: checksRun };
  }

  // Fail CLOSED. Publishing nothing is the correct outcome here.
  return { ok: false, text: null, reason: lastReason, attempts, checks: checksRun };
}

module.exports = {
  guardedCompose,
  checkCurrency, checkInventedNumbers, checkConstraints,
  checkSpecificity, checkTaglish, checkEnglishOnly, checkStance,
};
