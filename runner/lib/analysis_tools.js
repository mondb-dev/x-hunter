'use strict';

const { FRAMING_TACTICS } = require('./agent_beliefs');

// Basic keyword-based mapping. This is a starting point and can be
// expanded or replaced with a more sophisticated NLP/LLM-based approach.
const TACTIC_KEYWORDS = {
  [FRAMING_TACTICS.DEMONIZATION]: ['thugs', 'violent', 'rioters', 'extremists', 'terrorists', 'anarchists', 'mob'],
  [FRAMING_TACTICS.DELEGITIMIZATION]: ['astroturf', 'paid protestors', 'foreign funded', 'crisis actors', 'not organic', 'special interest'],
  [FRAMING_TACTICS.CRIMINALIZATION]: ['illegal', 'unlawful', 'blocking', 'trespassing', 'vandalism', 'arrested', 'crime'],
  [FRAMING_TACTICS.MINIMIZATION]: ['small group', 'fringe', 'few people', 'handful', 'no impact'],
  [FRAMING_TACTICS.DISTRACTION]: ['what about', 'but also', 'hypocrisy', 'focus on their mess'],
  [FRAMING_TACTICS.FEAR_MONGERING]: ['chaos', 'danger', 'threat to safety', 'destabilize', 'insecurity'],
  [FRAMING_TACTICS.PATRIOTIC_FRAMING]: ['unpatriotic', 'disloyal', 'against our country', 'betrayal'],
  [FRAMING_TACTICS.AGENT_PROVOCATEUR]: ['infiltrators', 'provocateurs', 'false flag', 'undercover'],
};

const DISSENT_KEYWORDS = ['protest', 'protestors', 'dissent', 'rally', 'march', 'activists', 'demonstration', 'strike', 'walkout', 'blockade'];

/**
 * Analyzes a text for signs of dissent framing.
 * This is a simple keyword-based implementation.
 *
 * @param {string} text The content to analyze.
 * @returns {import('./agent_beliefs').DissentFramingAnalysis | null} A structured analysis object, or null if not dissent-related.
 */
function analyzeDissentFraming(text) {
  const lowerText = text.toLowerCase();

  const isDissentRelated = DISSENT_KEYWORDS.some(kw => lowerText.includes(kw));
  if (!isDissentRelated) {
    return null;
  }

  const analysis = {
    is_dissent_related: true,
    tactics: [],
    // Nature, sources, and goals are harder to infer without more context or a powerful model.
    // This basic version focuses on tactics, which the main agent can then interpret.
    nature: undefined,
    sources: [],
    goals: [],
    summary: '',
  };

  const foundTactics = new Set();

  for (const tactic in TACTIC_KEYWORDS) {
    for (const keyword of TACTIC_KEYWORDS[tactic]) {
      if (lowerText.includes(keyword)) {
        foundTactics.add(tactic);
      }
    }
  }

  analysis.tactics = Array.from(foundTactics);

  if (analysis.tactics.length > 0) {
      analysis.summary = `The text discusses dissent and employs framing tactics such as: ${analysis.tactics.join(', ')}.`;
  }

  return analysis;
}

module.exports = {
  analyzeDissentFraming,
};
