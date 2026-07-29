'use strict';
/**
 * runner/lib/voice_filter.js — Mechanical post-draft filter (AGENTS.md §18.5)
 *
 * A last-line-of-defence library check that runs synchronously in post_tweet.js
 * and post_quote.js BEFORE posting. Complements the standalone voice_filter.js
 * Ollama pipeline step.
 *
 * Returns an array of error strings. Empty array = clean.
 */

const path   = require('path');
const config = require('./config');

/** Fold text to a comparable form: quote/dash variants unified, punctuation dropped. */
function normalizeForQuote(s) {
  return String(s || '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

// Quoted spans short enough to be scare quotes or a label ("political prisoners")
// rather than attributed speech. Below this word count we don't demand a source.
const QUOTE_MIN_WORDS = 4;

/**
 * Reject direct quotations that do not appear in the source being quoted.
 *
 * WHY (2026-07-28, quote cycle 4593): the Ollama voice pass rewrote
 * "Diokno refutes Cayetano's deflection..." into 'Diokno cut through Cayetano's
 * deflection cleanly. "Hindi ito about bank secrecy — ..."', inventing a verbatim
 * quotation and attributing it to a real named person. Nothing downstream checked
 * quotation marks against the source, so it published. The existing similarity
 * guard could not catch it: adding a sentence keeps most original words.
 *
 * An unverifiable quotation is treated as fabricated. That is deliberate — for
 * attributed speech, "we could not confirm they said it" and "they did not say
 * it" carry the same publishing risk.
 *
 * @param {string} draftText - the commentary about to be published
 * @param {string|null} sourceText - what the quoted post actually said (null = unavailable)
 * @returns {string[]} array of error messages (empty = pass)
 */
function checkQuotations(draftText, sourceText) {
  const errors = [];
  const spans = [...String(draftText || '').matchAll(/["“‟]([^"“”‟]{1,300})["”]/g)]
    .map(m => m[1].trim())
    .filter(Boolean);
  if (!spans.length) return errors;

  const haystack = normalizeForQuote(sourceText);

  for (const span of spans) {
    const norm = normalizeForQuote(span);
    if (norm.split(' ').filter(Boolean).length < QUOTE_MIN_WORDS) continue;

    const preview = span.length > 60 ? `${span.slice(0, 60)}…` : span;
    if (!haystack) {
      errors.push(`Unverifiable quotation: "${preview}" — no source text available to check it against`);
      continue;
    }
    // Elided quotations ("foo ... bar") are fine as long as every retained
    // fragment appears in the source. Split before normalizing — normalization
    // drops the ellipsis itself.
    const fragments = span.split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/)
      .map(normalizeForQuote)
      .filter(f => f.split(' ').filter(Boolean).length >= 2);
    const missing = fragments.length
      ? fragments.filter(f => !haystack.includes(f))
      : (haystack.includes(norm) ? [] : [norm]);
    if (missing.length) {
      errors.push(`Fabricated quotation: "${preview}" does not appear in the source post`);
    }
  }
  return errors;
}

/**
 * Check a draft text for grounding violations.
 * @param {string} draftText - the tweet/quote text to check
 * @param {{source?: string|null, requireQuoteSource?: boolean}} [opts]
 *   source - text of the post being quoted/replied to; enables quotation checking
 *   requireQuoteSource - run quotation checks even when source is absent (quote mode)
 * @returns {string[]} array of error messages (empty = pass)
 */
function check(draftText, opts = {}) {
  if (typeof draftText !== 'string') return [];
  const errors = [];

  if (opts.source || opts.requireQuoteSource) {
    errors.push(...checkQuotations(draftText, opts.source || null));
  }

  const currentDayNumber = Math.floor(
    (Date.now() - new Date(config.AGENT_START_DATE + 'T00:00:00Z').getTime()) / 86400000
  ) + 1;

  // Block future day references
  const dayRefs = [...draftText.matchAll(/\bDay\s+(\d+)\b/gi)];
  for (const match of dayRefs) {
    const n = parseInt(match[1], 10);
    if (n > currentDayNumber) {
      errors.push(
        `Temporal fabrication: references Day ${n} but current day is ${currentDayNumber}`
      );
    }
  }

  // Block vague unanchored temporal claims
  const vaguePatterns = [
    /\bfor (weeks|months|years)\b/i,
    /\bover the past (weeks|months)\b/i,
    /\bi have long (held|believed|noted|tracked)\b/i,
  ];
  for (const p of vaguePatterns) {
    const m = draftText.match(p);
    if (m) {
      errors.push(`Unanchored temporal claim: "${m[0]}"`);
    }
  }

  // Block analyst-mode language: abstract phrases without a named concrete referent.
  // These patterns produce press-release tone, not genuine voice.
  const analystPatterns = [
    { re: /\bdemands?\s+scrutiny\b/i,           msg: 'Analyst phrase: "demands scrutiny" — say what you think instead' },
    { re: /\bwarrants?\s+scrutiny\b/i,           msg: 'Analyst phrase: "warrants scrutiny" — say what you think instead' },
    { re: /\bthis\s+directly\s+challenges\b/i,   msg: 'Analyst opener: "This directly challenges" — start with the fact' },
    { re: /\breveals?\s+a\s+pattern\s+of\b/i,    msg: 'Analyst phrase: "reveals a pattern of" — name the pattern' },
    { re: /\bexposes?\s+a\s+pattern\s+of\b/i,    msg: 'Analyst phrase: "exposes a pattern of" — name the pattern' },
    { re: /\bmanufactured\s+consent\b/i,          msg: 'Abstract phrase: "manufactured consent" — name who did what' },
    { re: /\bhistorical\s+analogies?\s+(are\s+used|as\s+a)\b/i, msg: 'Abstract phrase: historical analogies as mechanism — name the specific analogy' },
    { re: /\bstrategic\s+narratives?\b/i,         msg: 'Abstract phrase: "strategic narrative(s)" — name the specific claim or actor' },
    { re: /\bcalls?\s+into\s+question\b/i,        msg: 'Press-release phrase: "calls into question" — state your actual position' },
    { re: /\brain of silence\b/i,                 msg: 'Cliché: "rain of silence"' },
    { re: /\bnarrative\s+control\b/i,             msg: 'Abstract phrase: "narrative control" — name who did what specifically' },
    { re: /\bnarrative\s+manipulation\b/i,        msg: 'Abstract phrase: "narrative manipulation" — name the specific act' },
  ];
  for (const { re, msg } of analystPatterns) {
    if (re.test(draftText)) {
      errors.push(msg);
    }
  }

  // Block engagement-filler tics. Every drafting prompt already bans these, but
  // they still reached production (e.g. a posted mention reply ending in
  // "Great question.") — so enforce mechanically too.
  const fillerPatterns = [
    { re: /\bgreat (question|point|take|thread)\b/i, msg: 'Filler: "great question/point" — engage with the substance or say nothing' },
    { re: /\bgood (question|point)\b/i,              msg: 'Filler: "good question/point" — engage with the substance or say nothing' },
    { re: /\bthanks for (asking|sharing|this)\b/i,   msg: 'Filler: "thanks for asking/sharing"' },
    { re: /\blove (this|it)[.!]?\s*$/i,              msg: 'Filler: trailing "love this"' },
  ];
  for (const { re, msg } of fillerPatterns) {
    if (re.test(draftText)) {
      errors.push(msg);
    }
  }

  return errors;
}

module.exports = { check, checkQuotations };
