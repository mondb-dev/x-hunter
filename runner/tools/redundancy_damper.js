'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../');
const ONTOLOGY_PATH = path.join(PROJECT_ROOT, 'state/ontology.json');
const DELTA_PATH = path.join(PROJECT_ROOT, 'state/ontology_delta.json');

/**
 * Calculates the Jaccard similarity between two texts.
 * @param {string} text1 The first text.
 * @param {string} text2 The second text.
 * @returns {number} The Jaccard similarity score (0 to 1).
 */
function calculateJaccard(text1, text2) {
    if (!text1 || !text2) return 0;
    const set1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const set2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    if (union.size === 0) return 0;
    return intersection.size / union.size;
}

/**
 * Main function to dampen belief updates based on redundancy.
 * Reads an ontology delta, compares new evidence to recent evidence in the main
 * ontology, and scales down the score change for redundant updates.
 */
function main() {
    if (!fs.existsSync(DELTA_PATH) || fs.statSync(DELTA_PATH).size === 0) {
        return; // No delta file to process, exit silently.
    }

    if (!fs.existsSync(ONTOLOGY_PATH)) {
        console.error('[redundancy_damper] Ontology file not found. Cannot process delta.');
        return;
    }

    let delta, ontology;
    try {
        delta = JSON.parse(fs.readFileSync(DELTA_PATH, 'utf-8'));
        ontology = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, 'utf-8'));
    } catch (e) {
        console.error('[redundancy_damper] Error parsing JSON files:', e.message);
        return;
    }

    if (!delta.updates || delta.updates.length === 0) {
        return; // No updates in delta file, exit silently.
    }

    const ontologyAxes = new Map(ontology.axes.map(axis => [axis.id, axis]));
    let changesMade = false;

    const dampenedUpdates = delta.updates.map(update => {
        const axis = ontologyAxes.get(update.axis_id);
        if (!axis || !axis.evidence_log || axis.evidence_log.length === 0) {
            return update; // No history to compare against
        }

        const newEvidence = update.evidence;
        if (!newEvidence || !newEvidence.text || !newEvidence.source) {
            return update; // Not enough info in the new evidence to check for redundancy
        }

        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);

        const recentEvidenceFromSource = axis.evidence_log.filter(log => {
            const logTimestamp = new Date(log.timestamp).getTime();
            return log.source === newEvidence.source && logTimestamp > twentyFourHoursAgo;
        });

        if (recentEvidenceFromSource.length === 0) {
            return update; // No recent evidence from this source
        }

        let maxSimilarity = 0;
        for (const oldEvidence of recentEvidenceFromSource) {
            const similarity = calculateJaccard(newEvidence.text, oldEvidence.text);
            if (similarity > maxSimilarity) {
                maxSimilarity = similarity;
            }
        }

        // Dampen if similarity is non-trivial
        if (maxSimilarity > 0.5) {
            const dampingFactor = 1 - maxSimilarity;
            const originalScoreChange = update.score_change;
            const dampenedScoreChange = originalScoreChange * dampingFactor;

            console.log(`[redundancy_damper] Dampening update for axis '${axis.id}'. Source: ${newEvidence.source}, Similarity: ${maxSimilarity.toFixed(2)}. Score change ${originalScoreChange.toFixed(4)} -> ${dampenedScoreChange.toFixed(4)}`);

            changesMade = true;
            return {
                ...update,
                score_change: dampenedScoreChange,
                dampening_applied: {
                    redundancy_score: maxSimilarity,
                    original_score_change: originalScoreChange,
                }
            };
        }

        return update;
    });

    if (changesMade) {
        const newDelta = { ...delta, updates: dampenedUpdates };
        try {
            fs.writeFileSync(DELTA_PATH, JSON.stringify(newDelta, null, 2));
            console.log('[redundancy_damper] Successfully dampened belief updates and updated delta file.');
        } catch (e) {
            console.error('[redundancy_damper] Error writing updated delta file:', e.message);
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = { calculateJaccard };
