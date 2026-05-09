'use strict';

const NARRATIVE_TACTICS = Object.freeze([
  'fabrication',
  'sensationalism',
  'fear-mongering',
  'conspiracy_theory',
  'strategic_ambiguity',
  'false_attribution',
  'whataboutism',
  'ad_hominem',
  'tribal_signaling',
  'ragebait',
  'engagement_farming',
  'claims_without_evidence',
  'other',
]);

// This schema defines the structure for narrative analysis metadata.
// It's designed to be attached to observations or evidence entries.
const narrativeAnalysisSchema = {
  tactic: { type: 'string', enum: NARRATIVE_TACTICS, required: true },
  tactic_confidence: { type: 'number', min: 0, max: 1, required: true },
  beneficiary: { type: 'string', description: 'Inferred entity or group that benefits from the narrative.', required: false },
  beneficiary_confidence: { type: 'number', min: 0, max: 1, required: false },
  strategic_goal: { type: 'string', description: 'The inferred strategic purpose of the narrative manipulation.', required: false },
  goal_confidence: { type: 'number', min: 0, max: 1, required: false },
  explanation: { type: 'string', description: 'Brief reasoning for the analysis.', required: false },
};

/**
 * Validates an object against the narrativeAnalysisSchema.
 * This is a simple validator, not a full-fledged library like Joi.
 *
 * @param {object} analysis - The narrative analysis object to validate.
 * @returns {{isValid: boolean, errors: string[]}}
 */
function validateNarrativeAnalysis(analysis) {
  const errors = [];
  if (!analysis || typeof analysis !== 'object') {
    errors.push('Analysis object is missing or not an object.');
    return { isValid: false, errors };
  }

  // Required fields
  if (typeof analysis.tactic !== 'string' || !NARRATIVE_TACTICS.includes(analysis.tactic)) {
    errors.push(`Invalid or missing tactic: "${analysis.tactic}". Must be one of [${NARRATIVE_TACTICS.join(', ')}].`);
  }
  if (typeof analysis.tactic_confidence !== 'number' || analysis.tactic_confidence < 0 || analysis.tactic_confidence > 1) {
    errors.push(`Invalid or missing tactic_confidence: "${analysis.tactic_confidence}". Must be a number between 0 and 1.`);
  }

  // Optional fields
  if (analysis.beneficiary !== undefined && typeof analysis.beneficiary !== 'string') {
    errors.push('If provided, beneficiary must be a string.');
  }
  if (analysis.beneficiary_confidence !== undefined && (typeof analysis.beneficiary_confidence !== 'number' || analysis.beneficiary_confidence < 0 || analysis.beneficiary_confidence > 1)) {
    errors.push(`If provided, beneficiary_confidence must be a number between 0 and 1.`);
  }
  if (analysis.strategic_goal !== undefined && typeof analysis.strategic_goal !== 'string') {
    errors.push('If provided, strategic_goal must be a string.');
  }
  if (analysis.goal_confidence !== undefined && (typeof analysis.goal_confidence !== 'number' || analysis.goal_confidence < 0 || analysis.goal_confidence > 1)) {
    errors.push(`If provided, goal_confidence must be a number between 0 and 1.`);
  }
  if (analysis.explanation !== undefined && typeof analysis.explanation !== 'string') {
    errors.push('If provided, explanation must be a string.');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

module.exports = {
  NARRATIVE_TACTICS,
  narrativeAnalysisSchema,
  validateNarrativeAnalysis,
};
