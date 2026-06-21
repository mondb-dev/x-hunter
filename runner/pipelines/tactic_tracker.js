'use strict';

const TACTIC_DEFINITIONS = require('../lib/tactic_definitions');

/**
 * Creates a regex from a pattern string, ensuring it's case-insensitive
 * and matches whole words.
 * @param {string} pattern - The keyword or phrase.
 * @returns {RegExp}
 */
function createPatternRegex(pattern) {
  // Escape special regex characters in the pattern
  const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Create a regex that matches whole words, case-insensitively
  return new RegExp(`\\b${escapedPattern}\\b`, 'gi');
}

// Pre-compile regexes for efficiency
const TACTICS_WITH_REGEX = TACTIC_DEFINITIONS.map(tactic => ({
  ...tactic,
  regexes: tactic.patterns.map(createPatternRegex),
}));

/**
 * Analyzes a block of text to identify and count occurrences of predefined
 * rhetorical tactics.
 *
 * @param {string} textContent - The text to analyze.
 * @returns {Object} An object where keys are tactic IDs and values are the count of occurrences.
 */
function analyzeTextForTactics(textContent) {
  const findings = {};

  if (!textContent || typeof textContent !== 'string') {
    return findings;
  }

  for (const tactic of TACTICS_WITH_REGEX) {
    let totalMatches = 0;
    for (const regex of tactic.regexes) {
      const matches = textContent.match(regex);
      if (matches) {
        totalMatches += matches.length;
      }
    }

    if (totalMatches > 0) {
      if (!findings[tactic.id]) {
        findings[tactic.id] = {
          count: 0,
          label: tactic.label
        };
      }
      findings[tactic.id].count += totalMatches;
    }
  }

  return findings;
}

module.exports = { analyzeTextForTactics };
