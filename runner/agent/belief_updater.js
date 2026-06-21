'use strict';

const { NARRATIVE_TACTICS } = require('../lib/schemas');

// Define penalty scores for each tactic. Higher values mean more penalty.
// These values are based on the AGENTS.md guidance on manipulation detection.
const TACTIC_PENALTIES = Object.freeze({
  fabrication: 1.0,
  claims_without_evidence: 0.8,
  conspiracy_theory: 0.8,
  fear_mongering: 0.7,
  ad_hominem: 0.7,
  ragebait: 0.6,
  sensationalism: 0.5,
  false_attribution: 0.5,
  whataboutism: 0.4,
  tribal_signaling: 0.3,
  strategic_ambiguity: 0.2,
  engagement_farming: 0.2,
  other: 0.1,
});

/**
 * Calculates a manipulation penalty based on the identified narrative tactic
 * and the confidence in that assessment. The penalty is a value between 0 and 1.
 *
 * @param {object} narrativeAnalysis - The structured narrative analysis object, conforming to narrativeAnalysisSchema.
 * @returns {number} A penalty score between 0.0 and 1.0.
 */
function calculateManipulationPenalty(narrativeAnalysis) {
  if (!narrativeAnalysis || !narrativeAnalysis.tactic) {
    return 0.0;
  }

  const { tactic, tactic_confidence } = narrativeAnalysis;
  const basePenalty = TACTIC_PENALTIES[tactic] || 0.0;

  // Use provided confidence, or a default of 0.5 if it's invalid/missing.
  const confidence = (typeof tactic_confidence === 'number' && tactic_confidence >= 0 && tactic_confidence <= 1)
    ? tactic_confidence
    : 0.5;

  // The penalty is the base penalty for the tactic, scaled by the confidence.
  return basePenalty * confidence;
}

/**
 * Prepares an update for a belief axis based on new evidence and its narrative analysis.
 * This function's main role is to calculate the manipulation penalty and prepare a
 * structured evidence log entry. It does not perform the full belief update but provides
 * key components for the agent's core belief update logic.
 *
 * @param {object} evidence - The new piece of evidence (e.g., { content: '...', source: '...' }).
 * @param {object} narrativeAnalysis - The narrative analysis for this evidence.
 * @returns {object} An object containing the calculated penalty and the new evidence log entry.
 */
function getBeliefUpdate(evidence, narrativeAnalysis) {
  const manipulationPenalty = calculateManipulationPenalty(narrativeAnalysis);

  const evidenceLogEntry = {
    ...evidence,
    narrative_analysis: narrativeAnalysis,
    timestamp: new Date().toISOString(),
  };

  // The caller (e.g., the core agent logic) will use this penalty in the full
  // persuasion formula: persuasion = (coherence + evidence + credibility) - manipulation_penalty
  return {
    manipulation_penalty: manipulationPenalty,
    new_evidence_log_entry: evidenceLogEntry,
  };
}

module.exports = {
  calculateManipulationPenalty,
  getBeliefUpdate,
  TACTIC_PENALTIES,
};
