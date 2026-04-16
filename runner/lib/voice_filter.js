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

  return errors;
}

module.exports = { check };
