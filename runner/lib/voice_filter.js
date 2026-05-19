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

/**
 * Check a draft text for grounding violations.
 * @param {string} draftText - the tweet/quote text to check
 * @returns {string[]} array of error messages (empty = pass)
 */
function check(draftText) {
  if (typeof draftText !== 'string') return [];
  const errors = [];

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

  return errors;
}

module.exports = { check };
