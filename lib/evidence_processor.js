'use strict';

const { strict: assert } = require('assert');

const RELEVANCE_THRESHOLD = 0.20;

/**
 * Calculates Jaccard similarity between two sets (arrays of unique strings).
 * @param {string[]} setA - First set of keywords.
 * @param {string[]} setB - Second set of keywords.
 * @returns {number} Jaccard similarity score [0, 1].
 */
function jaccardSimilarity(setA, setB) {
    assert(Array.isArray(setA) && Array.isArray(setB), 'Inputs must be arrays.');
    if (setA.length === 0 || setB.length === 0) {
        return 0;
    }
    const uniqueA = new Set(setA);
    const uniqueB = new Set(setB);
    const intersection = new Set([...uniqueA].filter(x => uniqueB.has(x)));
    const union = new Set([...uniqueA, ...uniqueB]);
    return intersection.size / union.size;
}

/**
 * Extracts a keyword set from a belief axis.
 * @param {object} axis - The belief axis object.
 * @returns {string[]} A list of unique keywords.
 */
function getKeywordsForAxis(axis) {
    const text = [
        axis.label,
        axis.left_pole,
        axis.right_pole,
        ...(axis.topics || [])
    ].join(' ').toLowerCase();

    // Simple keyword extraction: split by non-alphanumeric characters and filter stopwords
    const stopwords = new Set(['a', 'an', 'the', 'is', 'are', 'in', 'on', 'it', 'and', 'or', 'for', 'to', 'of']);
    const keywords = text
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 2 && !stopwords.has(word));

    return [...new Set(keywords)];
}

/**
 * Evaluates a piece of evidence against the belief ontology to find the best-matching axis.
 *
 * @param {object} evidence - The evidence item, must have a `keywords` array.
 * @param {object} ontology - The full ontology object with an `axes` array.
 * @returns {{ is_mapped: boolean, evidence: object, best_match: {axis_id: string, score: number}|null }}
 *          - `is_mapped`: true if relevance score is above threshold for any axis.
 *          - `evidence`: The original evidence item.
 *          - `best_match`: Details of the best matching axis if mapped.
 */
function processEvidence(evidence, ontology) {
    assert(evidence && Array.isArray(evidence.keywords), 'Evidence must have a keywords array.');
    assert(ontology && Array.isArray(ontology.axes), 'Ontology must have an axes array.');

    let bestMatch = null;
    let maxScore = -1;

    if (ontology.axes.length === 0) {
        return { is_mapped: false, evidence, best_match: null };
    }

    for (const axis of ontology.axes) {
        const axisKeywords = getKeywordsForAxis(axis);
        const score = jaccardSimilarity(evidence.keywords, axisKeywords);

        if (score > maxScore) {
            maxScore = score;
            bestMatch = { axis_id: axis.id, score };
        }
    }

    if (maxScore >= RELEVANCE_THRESHOLD) {
        return { is_mapped: true, evidence, best_match: bestMatch };
    }

    return { is_mapped: false, evidence, best_match: null };
}

module.exports = {
    processEvidence,
    getKeywordsForAxis,
    jaccardSimilarity,
};
