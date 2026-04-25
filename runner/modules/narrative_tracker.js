'use strict';

/**
 * A simple parser for the feed_digest.txt format.
 * Splits by '---' and parses key-value pairs and list items.
 * @param {string} rawContent
 * @returns {Array<object>}
 */
function parseFeedDigest(rawContent) {
  if (!rawContent || !rawContent.trim()) {
    return [];
  }
  const clusters = [];
  const rawClusters = rawContent.split('---');

  for (const rawCluster of rawClusters) {
    if (!rawCluster.trim()) continue;

    const cluster = { posts: [] };
    const lines = rawCluster.trim().split('\n');
    let currentPost = null;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      const isPostStart = /^\s*-\s/.test(line);
      const indentation = line.match(/^\s*/)[0].length;

      if (isPostStart) {
        if (currentPost) {
          cluster.posts.push(currentPost);
        }
        currentPost = {};
        const content = line.substring(line.indexOf('-') + 1).trim();
        const [key, ...valueParts] = content.split(':');
        if (key && valueParts.length > 0) {
          currentPost[key.trim()] = valueParts.join(':').trim();
        }
      } else if (indentation > 0 && currentPost) {
        const [key, ...valueParts] = trimmedLine.split(':');
        if (key && valueParts.length > 0) {
          currentPost[key.trim()] = valueParts.join(':').trim();
        }
      } else {
        const [key, ...valueParts] = trimmedLine.split(':');
        if (key && valueParts.length > 0) {
          const value = valueParts.join(':').trim();
          if (key.trim() === 'keywords') {
            cluster.keywords = value.split(',').map(k => k.trim());
          } else {
            cluster[key.trim()] = value;
          }
        }
      }
    }
    if (currentPost) {
      cluster.posts.push(currentPost);
    }
    if (cluster.cluster_id) {
      clusters.push(cluster);
    }
  }
  return clusters;
}

const CONTESTED_TOPIC_DEFINITIONS = {
  iran_protests: {
    keywords: ['iran', 'protest'],
    narrative_keywords: {
      foreign_influence: ['funding', 'israel', 'us', 'cia'],
      grassroots: ['grassroots', 'people', 'woman', 'life', 'freedom'],
    },
  },
  quran_interpretation: {
    keywords: ['quran', 'scholars'],
    narrative_keywords: {
      justifies_violence: ['justify', 'violence', 'torture'],
      misinterpretation: ['misinterpretation', 'context', 'peace'],
    },
  },
  refugee_framing: {
    keywords: ['refugees', 'europe', 'men'],
    narrative_keywords: {
      threat: ['military-aged', 'invasion', 'danger'],
      humanitarian: ['asylum', 'seeking', 'help', 'fleeing'],
    },
  },
};

/**
 * Identifies and tracks contested narratives from post clusters.
 * @param {Array<object>} clusters - Parsed clusters from feed_digest.
 * @param {object} currentState - The current narrative state from narratives.json.
 * @returns {object} The updated state.
 */
function trackContestation(clusters, currentState) {
  const state = currentState;

  for (const cluster of clusters) {
    if (!cluster.keywords || cluster.posts.length === 0) {
      continue;
    }

    for (const [topicId, def] of Object.entries(CONTESTED_TOPIC_DEFINITIONS)) {
      const isRelevant = def.keywords.every(kw => cluster.keywords.includes(kw));
      if (!isRelevant) {
        continue;
      }

      if (!state.contested_topics[topicId]) {
        state.contested_topics[topicId] = {
          id: topicId,
          keywords: def.keywords,
          narratives: {},
          last_updated: new Date().toISOString(),
        };
      }
      const topic = state.contested_topics[topicId];
      topic.last_updated = new Date().toISOString();

      for (const [narrativeId, narrativeKws] of Object.entries(def.narrative_keywords)) {
        const supportsNarrative = narrativeKws.some(kw => cluster.keywords.includes(kw));
        if (supportsNarrative) {
          if (!topic.narratives[narrativeId]) {
            topic.narratives[narrativeId] = {
              id: narrativeId,
              posts: [],
              sources: [],
            };
          }
          const narrative = topic.narratives[narrativeId];

          for (const post of cluster.posts) {
            if (post.id && !narrative.posts.find(p => p.id === post.id)) {
              narrative.posts.push({ id: post.id, text: post.text || '' });
            }
            if (post.author && !narrative.sources.includes(post.author)) {
              narrative.sources.push(post.author);
            }
          }
        }
      }
    }
  }

  return state;
}

module.exports = {
  trackContestation,
  parseFeedDigest,
};
