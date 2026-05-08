'use strict';

const fs = require('fs');
const path = require('path');

// Keywords to identify threat/solution narratives.
// These are starting points and can be refined over time.
const THREAT_KEYWORDS = [
    'outbreak', 'crisis', 'threat', 'disaster', 'emergency', 'attack', 'warning', 'alert', 'hantavirus', 'virus', 'pandemic', 'bio-weapon', 'geopolitical crisis'
];
const SOLUTION_KEYWORDS = [
    'vaccine', 'solution', 'cure', 'remedy', 'breakthrough', 'treatment', 'antidote', 'protocol', 'new law', 'emergency measure'
];
const SKEPTICISM_KEYWORDS = [
    'skepticism', 'distrust', 'conspiracy', 'manipulation', 'hoax', 'false flag', 'pre-planned', 'plandemic', 'unverified', 'staged', 'doubt'
];

/**
 * A simple check if a text contains any of the keywords.
 * @param {string} text The text to check.
 * @param {string[]} keywords The list of keywords.
 * @returns {boolean} True if any keyword is found.
 */
function containsKeywords(text, keywords) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Analyzes a list of posts to detect threat-solution narrative patterns.
 * @param {object[]} posts An array of post objects. Each post should have `text` or `content`, a `timestamp` or `created_at`, and an `id`.
 * @param {number} [timeWindowMinutes=480] The maximum time in minutes between a threat and a solution. Defaults to 8 hours.
 * @returns {object[]} An array of detected narrative patterns.
 */
function detectThreatSolutionNarrative(posts, timeWindowMinutes = 480) {
    const detectedPatterns = [];
    const threats = [];
    const solutions = [];

    // 1. Classify posts based on keywords
    for (const post of posts) {
        const text = post.content || post.text || '';
        if (containsKeywords(text, THREAT_KEYWORDS)) {
            threats.push(post);
        }
        if (containsKeywords(text, SOLUTION_KEYWORDS)) {
            solutions.push(post);
        }
    }

    // 2. Find threat-solution pairs within the time window
    for (const threat of threats) {
        for (const solution of solutions) {
            const threatTime = new Date(threat.timestamp || threat.created_at);
            const solutionTime = new Date(solution.timestamp || solution.created_at);

            // Solution must come at or after the threat
            if (solutionTime < threatTime) continue;

            const timeDiffMinutes = (solutionTime - threatTime) / (1000 * 60);

            if (timeDiffMinutes <= timeWindowMinutes) {
                // 3. Find associated public reaction (skepticism) around the same time frame
                const reactionPosts = posts.filter(p => {
                    const postTime = new Date(p.timestamp || p.created_at);
                    // Reaction should be after the threat and around the time of the solution
                    return postTime >= threatTime && containsKeywords(p.content || p.text || '', SKEPTICISM_KEYWORDS);
                });

                detectedPatterns.push({
                    id: `tsn-${threat.id}-${solution.id}`,
                    title: 'Threat-Solution Narrative Pattern Detected',
                    threat: {
                        id: threat.id,
                        text: threat.content || threat.text,
                        timestamp: threatTime.toISOString(),
                    },
                    solution: {
                        id: solution.id,
                        text: solution.content || solution.text,
                        timestamp: solutionTime.toISOString(),
                    },
                    temporal_proximity_minutes: Math.round(timeDiffMinutes),
                    reactions: reactionPosts.map(r => ({
                        id: r.id,
                        text: r.content || r.text,
                        timestamp: (r.timestamp || r.created_at),
                    })),
                    created_at: new Date().toISOString(),
                });
            }
        }
    }

    // Deduplicate patterns based on the generated ID
    const uniquePatterns = Array.from(new Map(detectedPatterns.map(p => [p.id, p])).values());

    return uniquePatterns;
}

module.exports = {
    detectThreatSolutionNarrative,
    THREAT_KEYWORDS,
    SOLUTION_KEYWORDS,
    SKEPTICISM_KEYWORDS
};
