'use strict';

const rhetoricDetector = require('./rhetoric_detector');

/**
 * Parses a content object (e.g., a tweet), analyzes its text for rhetorical tactics,
 * and returns a structured analysis.
 *
 * @param {object} contentObject - The content to parse, expected to have a `text` property.
 * @param {string} contentObject.id - A unique identifier for the content.
 * @param {string} contentObject.text - The textual content to analyze.
 * @param {object} [context={}] - Additional context about the content (e.g., author, source).
 * @returns {object|null} A structured analysis object or null if content is invalid.
 */
function parseContent(contentObject, context = {}) {
    if (!contentObject || !contentObject.text || typeof contentObject.text !== 'string') {
        return null;
    }

    const textToAnalyze = contentObject.text;

    const rhetoricAnalysis = rhetoricDetector.analyze(textToAnalyze);

    // The manipulation_score is a direct input for the persuasion penalty in AGENTS.md
    const manipulationScore = rhetoricAnalysis.total_score;

    return {
        id: contentObject.id,
        source_text: textToAnalyze,
        analyzed_at: new Date().toISOString(),
        context: context,
        analysis: {
            rhetoric: rhetoricAnalysis,
            // Future analyses (e.g., entity extraction, sentiment) could be added here.
        },
        manipulation_score: manipulationScore,
    };
}

module.exports = {
    parseContent,
};
