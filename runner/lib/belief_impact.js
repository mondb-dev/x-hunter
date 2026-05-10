'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.resolve(__dirname, '../../state');
const IMPACT_LOG_PATH = path.join(STATE_DIR, 'belief_impact_log.jsonl');

/**
 * Creates a map of axis ID to axis object for quick lookup.
 * @param {Array<Object>} axes - The array of axis objects.
 * @returns {Map<string, Object>} A map from axis ID to axis.
 */
function createAxisMap(axes) {
    const map = new Map();
    if (Array.isArray(axes)) {
        for (const axis of axes) {
            if (axis && axis.id) {
                map.set(axis.id, axis);
            }
        }
    }
    return map;
}

/**
 * Determines the impact type and strength based on score and confidence changes.
 * A "reinforcement" increases confidence or moves the score further from zero in its current direction.
 * A "challenge" decreases confidence or moves the score closer to zero (or across it).
 * @param {Object} oldAxis - The axis state before the update.
 * @param {Object} newAxis - The axis state after the update.
 * @returns {Object | null} An object with type and strength, or null if no significant change.
 */
function determineImpact(oldAxis, newAxis) {
    const scoreDelta = newAxis.score - oldAxis.score;
    const confDelta = newAxis.confidence - oldAxis.confidence;

    // Ignore negligible floating point variations
    if (Math.abs(scoreDelta) < 1e-6 && Math.abs(confDelta) < 1e-6) {
        return null;
    }

    let type = 'challenge'; // Default to challenge
    // Reinforcement: moving further from 0, or increasing confidence without changing score direction.
    if ((Math.abs(newAxis.score) > Math.abs(oldAxis.score) && Math.sign(newAxis.score) === Math.sign(oldAxis.score)) ||
        (Math.abs(scoreDelta) < 1e-6 && confDelta > 0)) {
        type = 'reinforcement';
    }

    // Strength is based on the magnitude of change. Score changes are more significant.
    const totalChange = Math.abs(scoreDelta) + Math.abs(confDelta) / 2;
    let strength;
    if (totalChange >= 0.05) {
        strength = 'high';
    } else if (totalChange >= 0.01) {
        strength = 'medium';
    } else {
        strength = 'low';
    }

    return {
        type,
        strength,
        scoreDelta: parseFloat(scoreDelta.toFixed(5)),
        confDelta: parseFloat(confDelta.toFixed(5))
    };
}

/**
 * Logs belief impacts to a file.
 * @param {Array<Object>} impacts - An array of impact objects to log.
 */
function logImpacts(impacts) {
    if (impacts.length === 0) {
        return;
    }
    try {
        const logLines = impacts.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        fs.appendFileSync(IMPACT_LOG_PATH, logLines);
        console.log(`[belief_impact] Logged ${impacts.length} belief impact(s) to ${path.basename(IMPACT_LOG_PATH)}.`);
    } catch (error) {
        console.error(`[belief_impact] ERROR: Failed to write to impact log: ${error.message}`);
    }
}

module.exports = {
    createAxisMap,
    determineImpact,
    logImpacts,
};
