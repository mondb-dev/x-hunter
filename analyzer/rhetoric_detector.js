'use strict';

const fs = require('fs');
const path = require('path');

let taxonomy = null;
const TAXONOMY_PATH = path.join(__dirname, '../data/narrative_tactics_taxonomy.json');

/**
 * Loads and caches the narrative tactics taxonomy from a JSON file.
 * Pre-processes keywords into regular expressions for efficient matching.
 * @returns {object} The loaded and processed taxonomy.
 */
function loadTaxonomy() {
    if (taxonomy) {
        return taxonomy;
    }

    try {
        if (!fs.existsSync(TAXONOMY_PATH)) {
            throw new Error(`Taxonomy file not found at ${TAXONOMY_PATH}`);
        }
        const rawdata = fs.readFileSync(TAXONOMY_PATH, 'utf-8');
        const loadedTaxonomy = JSON.parse(rawdata);

        // Pre-process keywords for regex matching to improve performance
        if (loadedTaxonomy.tactics && Array.isArray(loadedTaxonomy.tactics)) {
            loadedTaxonomy.tactics.forEach(tactic => {
                if (tactic.keywords && tactic.keywords.length > 0) {
                    // Create a case-insensitive regex from keywords, ensuring they are treated as whole words
                    const escapedKeywords = tactic.keywords.map(k => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
                    tactic.regex = new RegExp(`\\b(${escapedKeywords.join('|')})\\b`, 'gi');
                }
            });
        }
        taxonomy = loadedTaxonomy;
        return taxonomy;
    } catch (error) {
        console.error('CRITICAL: Error loading or parsing narrative tactics taxonomy:', error);
        // Return a default empty structure on error to prevent crashing consumers
        return { version: "0.0.0", tactics: [] };
    }
}

/**
 * Analyzes a piece of text for rhetorical tactics based on the loaded taxonomy.
 * @param {string} text The text to analyze.
 * @returns {object} An object containing detected tactics and their scores.
 */
function analyze(text) {
    const loadedTaxonomy = loadTaxonomy();
    if (!text || typeof text !== 'string') {
        return { detected_tactics: [], total_score: 0, polarization_score: 0, deflection_score: 0 };
    }

    const detected_tactics = [];
    let total_score = 0;
    let polarization_score = 0;
    let deflection_score = 0;

    if (loadedTaxonomy.tactics) {
        loadedTaxonomy.tactics.forEach(tactic => {
            if (!tactic.regex) return;

            const matches = text.match(tactic.regex);
            if (matches && matches.length > 0) {
                const score = matches.length * (tactic.weight || 1.0);
                detected_tactics.push({
                    id: tactic.id,
                    name: tactic.name,
                    category: tactic.category,
                    score: score,
                    matches: [...new Set(matches.map(m => m.toLowerCase()))] // unique, lowercased matches
                });
                total_score += score;
                if (tactic.category === 'Polarization') {
                    polarization_score += score;
                } else if (tactic.category === 'Deflection') {
                    deflection_score += score;
                }
            }
        });
    }

    return {
        detected_tactics,
        total_score,
        polarization_score,
        deflection_score,
    };
}

module.exports = {
    analyze,
};
