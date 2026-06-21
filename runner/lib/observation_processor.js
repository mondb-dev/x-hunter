'use strict';

const { analyzeDissentFraming } = require('./analysis_tools');

/**
 * @fileoverview Processes raw observations to add structured analysis layers.
 */

/**
 * An observation from the feed digest.
 * (This is a simplified assumption of the structure).
 * @typedef {Object} RawObservation
 * @property {string} id
 * @property {string} text
 * @property {string} author
 * @property {any[]} [other_fields]
 */

/**
 * An observation enriched with analysis.
 * @typedef {RawObservation & { analysis: { dissent_framing: import('./agent_beliefs').DissentFramingAnalysis | null } }} EnrichedObservation
 */

/**
 * Processes a list of raw observations and adds analysis.
 *
 * @param {RawObservation[]} observations - An array of observation objects.
 * @returns {EnrichedObservation[]} The array of observations, with an `analysis` property added.
 */
function processObservations(observations) {
  if (!Array.isArray(observations)) {
    return [];
  }

  return observations.map(obs => {
    // Ensure obs and obs.text are valid before processing
    if (!obs || typeof obs.text !== 'string') {
        return {
            ...obs,
            analysis: { ...(obs ? obs.analysis : {}), dissent_framing: null }
        };
    }

    const dissentFramingAnalysis = analyzeDissentFraming(obs.text);

    return {
      ...obs,
      analysis: {
        ...(obs.analysis || {}), // Preserve other potential analyses
        dissent_framing: dissentFramingAnalysis,
      },
    };
  });
}

/**
 * A utility to format the analysis for easy inclusion in prompts.
 * @param {EnrichedObservation} observation
 * @returns {string} A formatted string of the analysis, or an empty string.
 */
function formatAnalysisForPrompt(observation) {
    if (!observation?.analysis?.dissent_framing) {
        return '';
    }

    const analysis = observation.analysis.dissent_framing;
    if (!analysis.is_dissent_related || analysis.tactics.length === 0) {
        return '';
    }

    let report = '[Dissent Framing Detected]\n';
    report += `- Tactics: ${analysis.tactics.join(', ')}\n`;

    return report;
}

module.exports = {
  processObservations,
  formatAnalysisForPrompt,
};
