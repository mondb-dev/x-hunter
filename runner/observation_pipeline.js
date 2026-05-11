'use strict';

const path = require('path');
const narrativeTools = require('./lib/narrative_analysis_tools');

const NARRATIVE_TACTICS_DB_PATH = path.join(__dirname, '../../state/narrative_tactics_db.json');

/**
 * Analyzes a collection of content items to detect and tag narrative tactics.
 * This is the main entry point for the narrative analysis stage of the observation pipeline.
 *
 * @param {Array<Object>} contentItems - An array of objects to be analyzed.
 *   Each object must have a `text` property (string).
 * @returns {Array<Object>} The array of content items, with a new `narrative_tactics`
 *   property (Array<string>) added to each item.
 */
function analyzeContent(contentItems) {
    if (!Array.isArray(contentItems)) {
        console.error('analyzeContent expects an array of content items.');
        return [];
    }

    const tactics = narrativeTools.loadTactics(NARRATIVE_TACTICS_DB_PATH);
    if (!tactics || tactics.length === 0) {
        console.warn('Narrative tactics taxonomy not loaded or is empty. Skipping analysis.');
        // Return items with an empty array to maintain a consistent data shape
        return contentItems.map(item => ({
            ...item,
            narrative_tactics: [],
        }));
    }

    return contentItems.map(item => {
        const textToAnalyze = item.text || '';
        const detectedIds = narrativeTools.detectTactics(textToAnalyze, tactics);

        return {
            ...item,
            narrative_tactics: detectedIds,
        };
    });
}

module.exports = {
    analyzeContent,
};
