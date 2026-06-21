'use strict';

const fs = require('fs');
const path = require('path');
const { createAxisMap, determineImpact, logImpacts } = require('./lib/belief_impact');

const STATE_DIR = path.resolve(__dirname, '../state');
const ONTOLOGY_PATH = path.join(STATE_DIR, 'ontology.json');
const DELTA_PATH = path.join(STATE_DIR, 'ontology_delta.json');

function main() {
    if (!fs.existsSync(DELTA_PATH)) {
        console.log('[claim_tracker] no delta -- nothing to do');
        return;
    }

    let rawDelta;
    try {
        rawDelta = fs.readFileSync(DELTA_PATH, 'utf8');
        if (!rawDelta.trim()) {
            console.log('[claim_tracker] delta is empty -- nothing to do');
            return;
        }
    } catch (error) {
        console.error(`[claim_tracker] ERROR: Failed to read delta file: ${error.message}`);
        return;
    }

    try {
        const delta = JSON.parse(rawDelta);

        if (!delta.axes || delta.axes.length === 0) {
            console.log('[claim_tracker] no axis updates in delta -- nothing to track');
            return;
        }

        if (!fs.existsSync(ONTOLOGY_PATH)) {
            console.error('[claim_tracker] ERROR: ontology.json not found. Cannot compare for impact.');
            return;
        }
        const ontology = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, 'utf8'));
        const oldAxesMap = createAxisMap(ontology.axes);

        const impacts = [];
        const timestamp = new Date().toISOString();

        for (const updatedAxis of delta.axes) {
            if (!updatedAxis || !updatedAxis.id) continue;

            const oldAxis = oldAxesMap.get(updatedAxis.id);
            // Only track impacts on existing axes, not new ones.
            if (!oldAxis) continue;

            const impact = determineImpact(oldAxis, updatedAxis);
            if (!impact) continue;

            // The agent is expected to add the new evidence to the end of the log.
            const latestEvidence = updatedAxis.evidence_log && updatedAxis.evidence_log.length > 0
                ? updatedAxis.evidence_log[updatedAxis.evidence_log.length - 1]
                : null;

            const impactEntry = {
                timestamp,
                axis_id: updatedAxis.id,
                type: impact.type,
                strength: impact.strength,
                source_ref: latestEvidence ? (latestEvidence.ref || latestEvidence.url || 'unknown') : 'unknown',
                delta: {
                    score: impact.scoreDelta,
                    confidence: impact.confDelta,
                },
                values: {
                    old: { score: oldAxis.score, confidence: oldAxis.confidence },
                    new: { score: updatedAxis.score, confidence: updatedAxis.confidence },
                }
            };
            impacts.push(impactEntry);
        }

        if (impacts.length > 0) {
            logImpacts(impacts);
        } else {
            console.log('[claim_tracker] no significant belief impacts detected in delta.');
        }

    } catch (error) {
        // Catch parsing errors or other logic failures
        console.error(`[claim_tracker] ERROR: Failed to process belief impact: ${error.message}`);
        console.error(error.stack);
    }
}

main();
