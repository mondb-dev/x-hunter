'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');

const INTERACTIONS_PATH = path.join(config.STATE_DIR, 'interactions.json');
const ARTICLES_DIR = path.join(config.PROJECT_ROOT, 'articles');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'is', 'are', 'to', 'for', 'with',
  'on', 'by', 'at', 'from', 'as', 'this', 'that', 'it', 'its', 'be', 'been',
  'was', 'were', 'will', 'would', 'can', 'could', 'should', 'into', 'than',
  'then', 'there', 'their', 'them', 'they', 'you', 'your', 'our', 'ours',
  'about', 'after', 'before', 'while', 'when', 'what', 'which', 'who', 'how',
  'why', 'but', 'not', 'just', 'also', 'very', 'more', 'most', 'much', 'some',
  'such', 'only', 'over', 'under', 'have', 'has', 'had', 'do', 'does', 'did',
]);

const OWN_HANDLES = new Set(['sebastianhunts', 'sebastian_hunts']);
const MIN_MATCH_TEXT_CHARS = 40;
const MIN_SHARED_TOKENS = 8;
const CONTAINMENT_CHARS = 70;
const OVERLAP_THRESHOLD = 0.85;
const JACCARD_THRESHOLD = 0.55;

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function stripUrls(text) {
  return String(text || '').replace(/https?:\/\/\S+/gi, ' ');
}

function stripMarkdown(text) {
  return String(text || '')
    .replace(/^#{1,6}\s+/gm, ' ')
    .replace(/`+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[_*~>#-]/g, ' ');
}

function normalizeText(text) {
  return stripMarkdown(stripUrls(text))
    .toLowerCase()
    .replace(/@[a-z0-9_]+/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return new Set(keywordTerms(text));
}

function keywordTerms(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

function ngramSet(terms, n) {
  const grams = new Set();
  for (let i = 0; i <= terms.length - n; i += 1) {
    grams.add(terms.slice(i, i + n).join(' '));
  }
  return grams;
}

function sharedTokenCount(setA, setB) {
  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) shared += 1;
  }
  return shared;
}

function cleanSnippetText(text) {
  return stripUrls(stripMarkdown(text)).replace(/\s+/g, ' ').trim();
}

function splitArticleSnippets(raw) {
  const out = [];
  const paragraphs = String(raw || '')
    .split(/\n\s*\n/g)
    .map(part => cleanSnippetText(part))
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.length >= 80) out.push(paragraph);

    const sentences = paragraph
      .split(/(?<=[.!?])\s+/)
      .map(sentence => cleanSnippetText(sentence))
      .filter(sentence => sentence.length >= 60);

    for (const sentence of sentences) out.push(sentence);
  }

  return out;
}

function addSnippet(snippets, sourceType, reference, text) {
  const cleaned = cleanSnippetText(text);
  if (!cleaned || cleaned.length < MIN_MATCH_TEXT_CHARS) return;
  const norm = normalizeText(cleaned);
  const terms = keywordTerms(cleaned);
  const tokens = tokenize(cleaned);
  if (!norm || tokens.size < 6) return;
  snippets.push({
    source_type: sourceType,
    reference,
    text: cleaned,
    norm,
    terms,
    tokens,
    bigrams: ngramSet(terms, 2),
  });
}

function loadAuthoredCorpus() {
  const snippets = [];

  const posts = loadJson(config.POSTS_LOG_PATH)?.posts || [];
  for (let i = 0; i < posts.length; i += 1) {
    const post = posts[i];
    const raw = String(post.content || post.text || '').split('\n')[0];
    const ref = post.tweet_url || post.source_url || `posts_log:${i}`;
    addSnippet(snippets, post.type === 'quote' ? 'quote' : 'tweet', ref, raw);
  }

  const replies = loadJson(INTERACTIONS_PATH)?.replies || [];
  for (const reply of replies.slice(-250)) {
    addSnippet(
      snippets,
      'reply',
      `interactions:${reply.id || 'unknown'}`,
      reply.our_reply || ''
    );
  }

  try {
    const articleFiles = fs.readdirSync(ARTICLES_DIR)
      .filter(file => file.endsWith('.md'))
      .sort()
      .slice(-40);

    for (const file of articleFiles) {
      const raw = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf-8');
      for (const snippet of splitArticleSnippets(raw)) {
        addSnippet(snippets, 'article', `articles/${file}`, snippet);
      }
    }
  } catch {
    // Articles are optional. Detection still works with posts + replies.
  }

  return snippets;
}

function createSelfEchoDetector() {
  const corpus = loadAuthoredCorpus();

  function findMatch(text) {
    const cleaned = cleanSnippetText(text);
    if (!cleaned || cleaned.length < MIN_MATCH_TEXT_CHARS) return null;

    const norm = normalizeText(cleaned);
    const terms = keywordTerms(cleaned);
    const tokens = tokenize(cleaned);
    if (!norm || tokens.size < 6) return null;
    const bigrams = ngramSet(terms, 2);

    let best = null;

    for (const snippet of corpus) {
      let score = 0;
      let reason = '';

      if (
        norm.length >= CONTAINMENT_CHARS &&
        (snippet.norm.includes(norm) || norm.includes(snippet.norm))
      ) {
        score = 1;
        reason = 'containment';
      } else {
        const shared = sharedTokenCount(tokens, snippet.tokens);
        const sharedBigrams = sharedTokenCount(bigrams, snippet.bigrams);
        if (shared < MIN_SHARED_TOKENS) continue;

        const overlap = shared / Math.min(tokens.size, snippet.tokens.size);
        const jaccard = shared / (tokens.size + snippet.tokens.size - shared);
        if (overlap >= OVERLAP_THRESHOLD && jaccard >= JACCARD_THRESHOLD) {
          score = Number((overlap * 0.7 + jaccard * 0.3).toFixed(3));
          reason = 'token_overlap';
        } else if (sharedBigrams >= 2 && jaccard >= 0.22) {
          score = Number(Math.min(0.99, 0.45 + sharedBigrams * 0.08 + jaccard * 0.2).toFixed(3));
          reason = 'phrase_overlap';
        }
      }

      if (!score) continue;
      if (!best || score > best.score) {
        best = {
          score,
          reason,
          source_type: snippet.source_type,
          reference: snippet.reference,
          excerpt: snippet.text.slice(0, 180),
        };
      }
    }

    return best;
  }

  return { corpus, findMatch };
}

module.exports = {
  OWN_HANDLES,
  createSelfEchoDetector,
  normalizeText,
};
