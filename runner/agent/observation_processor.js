'use strict';

const { validateNarrativeAnalysis, NARRATIVE_TACTICS } = require('../lib/schemas');

/**
 * Parses a raw text analysis from the agent and converts it into a structured
 * narrative analysis object. This acts as a bridge between the LLM's natural
 * language output and the strict schema required for system processing.
 *
 * The agent is expected to provide analysis in a key-value format, one per line.
 * Example:
 * Tactic: fear-mongering
 * Tactic Confidence: 0.8
 * Beneficiary: Domestic security apparatus
 * Strategic Goal: Increase public support for surveillance
 *
 * @param {string} rawAnalysisText - The free-form text from the agent.
 * @returns {{analysis: object|null, errors: string[]}}
 */
function processObservation(rawAnalysisText) {
  if (!rawAnalysisText || typeof rawAnalysisText !== 'string' || rawAnalysisText.trim() === '') {
    return { analysis: null, errors: ['Input text is empty or invalid.'] };
  }

  const analysis = {};
  const lines = rawAnalysisText.split('\n');

  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < 2) continue;

    const key = parts[0].trim().toLowerCase().replace(/\s+/g, '_');
    const value = parts.slice(1).join(':').trim();

    if (!value) continue;

    switch (key) {
      case 'tactic':
        analysis.tactic = value.toLowerCase().replace(/\s+/g, '_');
        break;
      case 'tactic_confidence':
        analysis.tactic_confidence = parseFloat(value);
        break;
      case 'beneficiary':
        analysis.beneficiary = value;
        break;
      case 'beneficiary_confidence':
        analysis.beneficiary_confidence = parseFloat(value);
        break;
      case 'strategic_goal':
        analysis.strategic_goal = value;
        break;
      case 'goal_confidence':
        analysis.goal_confidence = parseFloat(value);
        break;
      case 'explanation':
        analysis.explanation = value;
        break;
    }
  }

  // If no tactic is parsed, the analysis is invalid.
  if (!analysis.tactic) {
    return { analysis: null, errors: ['"Tactic" field is missing from the analysis text.'] };
  }

  const { isValid, errors } = validateNarrativeAnalysis(analysis);

  if (!isValid) {
    // Return the raw parsed object along with validation errors for debugging.
    return { analysis: analysis, errors };
  }

  return { analysis, errors: [] };
}

module.exports = {
  processObservation,
  NARRATIVE_TACTICS, // Re-export for convenience
};
