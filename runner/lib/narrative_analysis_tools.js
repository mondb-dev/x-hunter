'use strict';

const fs = require('fs');
const path = require('path');

let tacticsCache = null;

/**
 * Loads the narrative tactics taxonomy from a JSON file.
 * Caches the result after the first load and pre-compiles Regex patterns.
 * @param {string} dbPath - The path to the narrative_tactics_db.json file.
 * @returns {Array<Object>|null} The array of tactic objects, or null on error.
 */
function loadTactics(dbPath) {
    if (tacticsCache) {
        return tacticsCache;
    }

    try {
        if (!fs.existsSync(dbPath)) {
            console.error(`Error: Narrative tactics DB file not found at ${dbPath}`);
            return null;
        }
        const dbContent = fs.readFileSync(dbPath, 'utf8');
        const db = JSON.parse(dbContent);
        if (db && Array.isArray(db.tactics)) {
            // Pre-compile regexes for performance
            tacticsCache = db.tactics.map(tactic => {
                const indicators = tactic.indicators || [];
                tactic.compiledIndicators = indicators.map(indicator => {
                    try {
                        // Case-insensitive matching
                        return new RegExp(indicator, 'i');
                    } catch (e) {
                        console.error(`Invalid regex for tactic '${tactic.id}': /${indicator}/. Error: ${e.message}`);
                        return null;
                    }
                }).filter(Boolean); // Filter out nulls from invalid regexes
                return tactic;
            });
            return tacticsCache;
        }
        console.error('Narrative tactics DB is malformed. Expected a `tactics` array.');
        return null;
    } catch (error) {
        console.error(`Error loading or parsing narrative tactics DB: ${error.message}`);
        return null;
    }
}

/**
 * Detects narrative tactics in a given text based on the provided taxonomy.
 * @param {string} text - The input text to analyze.
 * @param {Array<Object>} tactics - The array of tactic objects (from loadTactics).
 * @returns {Array<string>} An array of IDs of the detected tactics.
 */
function detectTactics(text, tactics) {
    if (!text || typeof text !== 'string' || !Array.isArray(tactics)) {
        return [];
    }

    const detectedTacticIds = new Set();

    for (const tactic of tactics) {
        if (!tactic.compiledIndicators) continue;

        for (const regex of tactic.compiledIndicators) {
            if (regex.test(text)) {
                detectedTacticIds.add(tactic.id);
                // Move to the next tactic once one of its indicators matches
                break;
            }
        }
    }

    return Array.from(detectedTacticIds);
}

module.exports = {
    loadTactics,
    detectTactics,
};
