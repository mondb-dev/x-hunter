'use strict';

const { strict: assert } = require('assert');

const CLUSTER_SIMILARITY_THRESHOLD = 0.3;
const SIGNIFICANT_CLUSTER_MIN_SIZE = 3;
const MAX_SAMPLE_ITEMS = 3;
const MAX_SUMMARY_KEYWORDS = 5;

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
 * Performs single-linkage clustering on unmapped evidence items based on keyword Jaccard similarity.
 *
 * @param {object[]} unmappedItems - Array of evidence items. Each must have `id`, `content`, and `keywords`.
 * @returns {object[]} An array of significant cluster objects.
 */
function clusterThemes(unmappedItems) {
    if (!unmappedItems || unmappedItems.length < SIGNIFICANT_CLUSTER_MIN_SIZE) {
        return [];
    }

    // Initialize each item as its own cluster
    const clusters = unmappedItems.map(item => [item]);

    // A simple, greedy, single-pass clustering.
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < clusters.length; i++) {
            for (let j = i + 1; j < clusters.length; j++) {
                const clusterA = clusters[i];
                const clusterB = clusters[j];

                const isSimilar = clusterA.some(itemA =>
                    clusterB.some(itemB =>
                        jaccardSimilarity(itemA.keywords, itemB.keywords) >= CLUSTER_SIMILARITY_THRESHOLD
                    )
                );

                if (isSimilar) {
                    clusters[i] = clusterA.concat(clusterB);
                    clusters.splice(j, 1);
                    merged = true;
                    j = i; // Restart inner loop
                }
            }
        }
    }

    const significantClusters = clusters.filter(c => c.length >= SIGNIFICANT_CLUSTER_MIN_SIZE);

    return significantClusters.map((cluster, index) => {
        const allKeywords = cluster.flatMap(item => item.keywords);
        const keywordCounts = allKeywords.reduce((counts, keyword) => {
            counts[keyword] = (counts[keyword] || 0) + 1;
            return counts;
        }, {});

        const sortedKeywords = Object.entries(keywordCounts)
            .sort(([, countA], [, countB]) => countB - countA)
            .map(([keyword]) => keyword);

        const summaryKeywords = sortedKeywords.slice(0, MAX_SUMMARY_KEYWORDS);

        const sampleItems = cluster.slice(0, MAX_SAMPLE_ITEMS).map(item => ({
            id: item.id,
            content: item.content,
        }));

        return {
            id: `cluster_${Date.now()}_${index}`,
            summary: `Cluster of ${cluster.length} items. Top keywords: ${summaryKeywords.join(', ')}.`,
            keywords: sortedKeywords,
            item_count: cluster.length,
            sample_items: sampleItems,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            item_ids: cluster.map(item => item.id),
        };
    });
}

module.exports = {
    clusterThemes,
};
