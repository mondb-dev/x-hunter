'use strict';

// NOTE: Placing a .js module in the state/ directory is unconventional for this project's
// structure, but this path is followed as per the proposal's `affected_files`.
// This module is intended as a library for belief state management.

/**
 * Calculates the potential change in score for a belief axis based on new evidence.
 * This function directly implements the belief update formula from AGENTS.md,
 * incorporating the new manipulation penalty.
 *
 * persuasion = (coherence + evidence + credibility) − manipulation_penalty
 * Δscore = persuasion × novelty × diversity_weight × daily_cap
 *
 * @param {object} evidence - An evidence object.
 * @param {object} evidence.analysis - The analysis object from content_parser, containing the manipulation score.
 * @param {number} evidence.novelty - Novelty score of the evidence [0-1].
 * @param {number} evidence.diversity_weight - Diversity weight [0-1].
 * @param {number} evidence.coherence - Coherence score with existing beliefs [0-1].
 * @param {number} evidence.credibility - Credibility score of the source [0-1].
 * @param {object} axis - The belief axis this evidence applies to.
 * @param {object} daily_stats - Stats about updates today for this axis.
 * @param {number} daily_stats.change_today - The sum of score changes for the axis today.
 *
 * @returns {object} An object with calculated delta_score, new_confidence, and other metrics.
 */
function calculateBeliefUpdate(evidence, axis, daily_stats) {
    const DAILY_CAP = 0.05; // As defined in AGENTS.md

    // The manipulation_penalty is derived from the new rhetoric analysis module.
    // AGENTS.md: "persuasion = (coherence + evidence + credibility) − manipulation_penalty"
    const manipulation_penalty = evidence.analysis?.rhetoric?.total_score || 0;

    // Normalize penalty to be less overwhelming, e.g., capping its effect.
    // A score of 5 from the detector could be a reasonable max penalty.
    const normalized_penalty = Math.min(manipulation_penalty, 5) / 5.0;

    const persuasion = (evidence.coherence + evidence.credibility) - normalized_penalty;

    // Δscore = persuasion × novelty × diversity_weight
    let delta_score = persuasion * evidence.novelty * evidence.diversity_weight;

    // Apply daily cap logic from AGENTS.md
    const current_daily_change = daily_stats.change_today || 0;
    const potential_next_change = current_daily_change + delta_score;

    if (Math.abs(potential_next_change) > DAILY_CAP) {
        // If the change is in the same direction as today's trend, cap it.
        if (Math.sign(delta_score) === Math.sign(current_daily_change) || current_daily_change === 0) {
            delta_score = Math.sign(delta_score) * Math.max(0, DAILY_CAP - Math.abs(current_daily_change));
        }
        // If delta_score is in the opposite direction, we allow it, as it counteracts the daily trend.
    }
    
    // Confidence update logic (simplified for now as per AGENTS.md)
    // "Increase confidence with strong evidence + independent agreement"
    // "Decrease confidence with strong counterarguments + weak evidence"
    // High manipulation should decrease confidence in the update.
    let delta_confidence = 0.01 * (1 - normalized_penalty); // Base increase is reduced by manipulation.
    if (persuasion < 0) {
        delta_confidence -= 0.005; // Penalize confidence for very poor persuasion.
    }

    const new_confidence = Math.max(0.05, Math.min(1.0, axis.confidence + delta_confidence));

    return {
        delta_score,
        new_confidence,
        persuasion,
        manipulation_penalty,
    };
}

/**
 * Generates an ontology_delta.json object.
 * This is a conceptual placeholder demonstrating how `calculateBeliefUpdate` would be used.
 * The agent's reasoning layer would orchestrate this process.
 *
 * @param {Array<object>} updates - An array of updates to apply.
 * @param {string} ontologyPath - Path to the current ontology.json file.
 * @returns {object} The delta object to be written to state/ontology_delta.json
 */
function createOntologyDelta(updates, ontologyPath) {
    // The reasoning layer would read ontology.json, iterate through updates,
    // call calculateBeliefUpdate for each, and aggregate the results into a delta file.
    // This implementation is out of scope for this module.
    console.log('Usage: This function is conceptual. Use calculateBeliefUpdate() for individual calculations.');
    throw new Error('createOntologyDelta is not fully implemented.');
}

module.exports = {
    calculateBeliefUpdate,
    createOntologyDelta
};
