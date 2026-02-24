"use strict";
/**
 * scraper/analytics.js — pure data analytics functions
 *
 * No I/O. No side effects. All functions take data in, return data out.
 * Required by collect.js and query.js.
 *
 * Functions:
 *   sanitizePost         — filter ads/short/emoji-spam/non-English posts
 *   jaccardSimilarity    — keyword-set similarity [0..1]
 *   deduplicateByJaccard — remove near-duplicate posts (keeps highest-scoring)
 *   computeIDF           — corpus IDF map for novelty scoring
 *   noveltyBoost         — TF-IDF novelty score for a single post [0..5]
 *   clusterPosts         — greedy topic clustering by keyword Jaccard
 *   detectBursts         — compare keyword frequencies across two time windows
 *   tagClusterBursts     — mark clusters whose keywords are bursting
 */

// ── Text Sanitization ─────────────────────────────────────────────────────────

/**
 * Strip @handles, URLs, #tags from text — return cleaned content string.
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  return text
    .replace(/@\w+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/#\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Count emoji codepoints in a string.
 * Covers Extended-Pictographic range + supplementary planes.
 * @param {string} text
 * @returns {number}
 */
function countEmoji(text) {
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1F300) count++;
  }
  return count;
}

/**
 * Decide whether a scraped post should be kept or discarded.
 *
 * Filters:
 *   too_short    — cleaned content < 20 chars
 *   ad           — text contains "\nPromoted" (X ad injection)
 *   emoji_spam   — emoji density > 35% in short posts (< 80 cleaned chars)
 *   non_english  — ASCII word chars < 40% of total word chars
 *   repetition   — any single word repeated > 5x in < 100-char text
 *   no_text      — empty text field
 *
 * @param {{ text: string }} post
 * @returns {{ keep: boolean, reason: string }}
 */
function sanitizePost(post) {
  const raw = post.text || "";
  if (!raw) return { keep: false, reason: "no_text" };

  // Ad detection: X injects "Promoted" as a visible line in ad posts
  if (/\nPromoted$/.test(raw) || raw.endsWith("\nPromoted")) {
    return { keep: false, reason: "ad" };
  }

  const content = cleanText(raw);

  if (content.length < 20) return { keep: false, reason: "too_short" };

  // Emoji density on short posts
  const emojiCount = countEmoji(content);
  if (emojiCount > 0 && content.length < 80) {
    if (emojiCount / content.length > 0.35) return { keep: false, reason: "emoji_spam" };
  }

  // Non-English heuristic: low ASCII word ratio
  const wordChars = content.replace(/[^a-zA-Z\u00C0-\u024F]/g, "");
  const asciiWordChars = content.replace(/[^a-zA-Z]/g, "");
  if (wordChars.length > 10 && asciiWordChars.length / wordChars.length < 0.4) {
    return { keep: false, reason: "non_english" };
  }

  // Excessive word repetition in short text
  if (raw.length < 100) {
    const words = raw.toLowerCase().split(/\W+/).filter(Boolean);
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    if (Object.values(freq).some(c => c > 5)) return { keep: false, reason: "repetition" };
  }

  return { keep: true, reason: "" };
}

// ── Jaccard Similarity ────────────────────────────────────────────────────────

/**
 * Jaccard similarity of two keyword arrays treated as sets.
 * Returns |A ∩ B| / |A ∪ B|, or 0 if both sets are empty.
 *
 * @param {string[]} keywordsA
 * @param {string[]} keywordsB
 * @returns {number} [0..1]
 */
function jaccardSimilarity(keywordsA, keywordsB) {
  const a = new Set(keywordsA);
  const b = new Set(keywordsB);
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const kw of a) { if (b.has(kw)) intersect++; }
  const union = a.size + b.size - intersect;
  return intersect / union;
}

// ── Near-Duplicate Detection ──────────────────────────────────────────────────

/**
 * Remove near-duplicate posts using Jaccard similarity of keyword sets.
 *
 * Input must be sorted by score DESC — the highest-scoring copy of any
 * near-duplicate group is retained, lower-scoring copies are dropped.
 *
 * Posts with empty keyword arrays are never considered duplicates of each other
 * (Jaccard of two empty sets is 0 by definition above).
 *
 * @param {Array<{keywords: string[]}>} posts - score-sorted descending
 * @param {number} threshold - default 0.65
 * @returns {Array} deduplicated array, preserving order
 */
function deduplicateByJaccard(posts, threshold = 0.65) {
  const accepted = [];
  for (const post of posts) {
    if (!post.keywords || post.keywords.length === 0) {
      accepted.push(post); // no keywords → cannot be a duplicate
      continue;
    }
    const isDup = accepted.some(sel =>
      sel.keywords && sel.keywords.length > 0 &&
      jaccardSimilarity(post.keywords, sel.keywords) >= threshold
    );
    if (!isDup) accepted.push(post);
  }
  return accepted;
}

// ── TF-IDF Novelty ────────────────────────────────────────────────────────────

/**
 * Parse keyword field from DB row (comma-separated string) or pass-through array.
 * @param {string|string[]} keywords
 * @returns {string[]}
 */
function parseKeywords(keywords) {
  if (Array.isArray(keywords)) return keywords;
  if (!keywords) return [];
  return keywords.split(", ").filter(Boolean);
}

/**
 * Compute smoothed IDF for each keyword across a corpus.
 *
 * IDF formula: log((N+1) / (df+1))
 *   N  = number of documents in corpus
 *   df = number of documents containing the keyword
 *
 * Smoothing prevents log(0) and gives nonzero IDF to very common terms.
 *
 * @param {Array<{keywords: string|string[]}>} corpusPosts
 * @returns {Map<string, number>} keyword → IDF score
 */
function computeIDF(corpusPosts) {
  const N = corpusPosts.length;
  if (N === 0) return new Map();

  const df = new Map(); // document frequency
  for (const post of corpusPosts) {
    const kws = new Set(parseKeywords(post.keywords));
    for (const kw of kws) {
      df.set(kw, (df.get(kw) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [kw, freq] of df.entries()) {
    idf.set(kw, Math.log((N + 1) / (freq + 1)));
  }
  return idf;
}

/**
 * Compute novelty score for a post using the precomputed IDF map.
 *
 * Score = mean IDF of post keywords, capped at 5.0.
 * Unknown keywords (not in corpus) receive max IDF = log(N+1).
 * Posts with no keywords return 0.
 *
 * High score → post discusses rare/novel topics this window.
 * Low score  → post discusses commonly recurring topics.
 *
 * @param {{ keywords: string|string[] }} post
 * @param {Map<string, number>} idfMap
 * @param {number} N - corpus size (for unknown keyword fallback IDF)
 * @returns {number} [0..5]
 */
function noveltyBoost(post, idfMap, N = 1) {
  const kws = parseKeywords(post.keywords);
  if (kws.length === 0) return 0;
  const maxIdf = Math.log(N + 1);
  const sum = kws.reduce((s, kw) => s + (idfMap.has(kw) ? idfMap.get(kw) : maxIdf), 0);
  return Math.min(5.0, sum / kws.length);
}

// ── Greedy Topic Clustering ───────────────────────────────────────────────────

/**
 * Cluster posts by Jaccard similarity of keyword sets using greedy
 * single-linkage: each post is compared against the cluster representative
 * (the first/highest-scoring post in that cluster). The first cluster
 * whose representative has similarity >= threshold absorbs the post.
 *
 * Complexity: O(n * k) where k = number of clusters formed.
 * With 25 posts this is negligible.
 *
 * @param {Array<{keywords: string[], score: number}>} posts - score-sorted DESC
 * @param {number} threshold - default 0.25
 * @returns {Array<Cluster>}
 *
 * Cluster shape:
 * {
 *   label:          string,       // "kw1 · kw2 · kw3" from representative
 *   posts:          Post[],       // sorted score DESC
 *   representative: Post,         // highest-scoring post (cluster seed)
 *   isBurst:        boolean,      // set by tagClusterBursts()
 * }
 */
function clusterPosts(posts, threshold = 0.25) {
  const clusters = [];

  for (const post of posts) {
    let placed = false;

    for (const cluster of clusters) {
      const rep = cluster.representative;
      if (
        rep.keywords && rep.keywords.length > 0 &&
        post.keywords && post.keywords.length > 0 &&
        jaccardSimilarity(post.keywords, rep.keywords) >= threshold
      ) {
        cluster.posts.push(post);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const label = (post.keywords || []).slice(0, 3).join(" · ") || "misc";
      clusters.push({
        label,
        posts:          [post],
        representative: post,
        isBurst:        false,
      });
    }
  }

  // Sort clusters by their best post's score DESC
  clusters.sort((a, b) => b.posts[0].score - a.posts[0].score);
  return clusters;
}

// ── Burst Detection ───────────────────────────────────────────────────────────

/**
 * Build a keyword frequency map from an array of post objects.
 * @param {Array<{keywords: string|string[]}>} posts
 * @returns {Map<string, number>}
 */
function buildFreqMap(posts) {
  const freq = new Map();
  for (const post of posts) {
    for (const kw of parseKeywords(post.keywords)) {
      freq.set(kw, (freq.get(kw) || 0) + 1);
    }
  }
  return freq;
}

/**
 * Detect keywords that are bursting in the current window vs. a previous window.
 *
 * A keyword bursts if:
 *   currentFreq >= 2  (appeared at least twice — not a one-off)
 *   AND currentFreq > previousFreq * 2.0  (more than doubled)
 *
 * @param {Array<{keywords: string|string[]}>} currentWindow  - recent posts
 * @param {Array<{keywords: string|string[]}>} previousWindow - older posts
 * @returns {Set<string>} set of bursting keyword strings
 */
function detectBursts(currentWindow, previousWindow) {
  const current  = buildFreqMap(currentWindow);
  const previous = buildFreqMap(previousWindow);
  const bursting = new Set();

  for (const [kw, count] of current.entries()) {
    const prevCount = previous.get(kw) || 0;
    if (count >= 2 && count > prevCount * 2.0) {
      bursting.add(kw);
    }
  }
  return bursting;
}

/**
 * Tag clusters whose representative keywords intersect with the burst set.
 * Mutates clusters in-place; also returns the array for chaining.
 *
 * @param {Cluster[]} clusters
 * @param {Set<string>} burstSet
 * @returns {Cluster[]}
 */
function tagClusterBursts(clusters, burstSet) {
  for (const cluster of clusters) {
    const kws = cluster.representative?.keywords || [];
    if (kws.some(kw => burstSet.has(kw))) {
      cluster.isBurst = true;
    }
  }
  return clusters;
}

// ── RAKE Keyword Extractor ────────────────────────────────────────────────────
// Rapid Automatic Keyword Extraction. Shared by collect.js and archive.js.
// No external deps. Splits on stop words, scores phrases by degree/frequency.

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","are","was","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","this","that",
  "these","those","it","its","he","she","they","we","you","i","my","your",
  "our","their","not","no","so","if","as","up","out","about","just","also",
  "than","then","when","where","who","what","how","all","more","most","some",
  "can","into","over","after","before","between","such","even","very","only",
  "well","still","here","there","now","get","got","like","been","never","one",
  "two","its","re","s","t","ve","ll","d","m","don","isn","aren","wasn","weren",
  "because","them","him","her","us","which","while","through","down","each",
]);

/**
 * Extract top keyphrases from text using RAKE.
 * @param {string} text
 * @param {number} topN - max phrases to return (default 8)
 * @returns {string[]}
 */
function extractKeywords(text, topN = 8) {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[@#]\w+/g, "")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);

  const phrases = [];
  let current = [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || /^\d+$/.test(word)) {
      if (current.length > 0) { phrases.push(current.slice()); current = []; }
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) phrases.push(current);

  const freq = {}, degree = {};
  for (const phrase of phrases) {
    for (const word of phrase) {
      freq[word]   = (freq[word]   || 0) + 1;
      degree[word] = (degree[word] || 0) + phrase.length - 1;
    }
  }

  const wordScore = {};
  for (const word of Object.keys(freq)) {
    wordScore[word] = (degree[word] + freq[word]) / freq[word];
  }

  const seen = new Set();
  return phrases
    .map(p => ({ phrase: p.join(" "), score: p.reduce((s, w) => s + wordScore[w], 0) }))
    .filter(p => { if (seen.has(p.phrase)) return false; seen.add(p.phrase); return p.phrase.length > 2; })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(p => p.phrase);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  sanitizePost,
  jaccardSimilarity,
  deduplicateByJaccard,
  computeIDF,
  noveltyBoost,
  clusterPosts,
  detectBursts,
  tagClusterBursts,
  extractKeywords,
  // Internal helpers exposed for testing
  cleanText,
  parseKeywords,
  buildFreqMap,
};
