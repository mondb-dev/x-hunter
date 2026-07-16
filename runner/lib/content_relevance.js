'use strict';
/**
 * runner/lib/content_relevance.js — shared relevance scoring + content guards for
 * outbound X actions (replies in x_engage, amplification in x_amplify). Extracted
 * so both paths share one scorer instead of drifting copies.
 *
 *   isSensitiveContent(text) / isSatireOrJoke(text)  hard-skip guards
 *   loadAxisKeywords()                               belief-axis vocabulary (tie-break)
 *   makeScorer(keywords)                             async (post) -> number
 *
 * The score is an LLM (local qwen) relevance rating 0-3 (+ a small keyword-hit
 * tie-breaker); guarded content returns -1. Same rubric x_engage has always used.
 */

const fs = require('fs');
const path = require('path');

const ONTOLOGY = path.join(path.resolve(__dirname, '..', '..'), 'state', 'ontology.json');

function isSensitiveContent(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(rape|child rape|sexual assault|molest|paedophile|pedophile|child abuse|grooming)\b/.test(t)) return true;
  if (/\b(trafficking|sex trafficking|epstein|diddy)\b/.test(t)) return true;
  if (/\b(killed|murdered|assassinated)\b.{0,40}\b(president|minister|senator|governor|mayor)\b/i.test(t)) return true;
  if (/\b(president|minister|senator|governor|mayor)\b.{0,40}\b(killed|murdered|assassinated)\b/i.test(t)) return true;
  return false;
}

function isSatireOrJoke(text) {
  const s = String(text || '');
  const t = s.toLowerCase();
  if (/\b(satire|parody|irony|ironic|sarcasm|sarcastic|just kidding|jk|lmao|lmfao|lol)\b/.test(t)) return true;
  if (/^(why did|what do you call|knock knock|fun fact:|hot take:|unpopular opinion:)/i.test(s)) return true;
  if (/😂|🤣|💀|😭/.test(s) || /\/s\b/.test(t)) return true;
  const emoji = (s.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
  return emoji >= 4 && s.length < 80;
}

function loadAxisKeywords() {
  try {
    const o = JSON.parse(fs.readFileSync(ONTOLOGY, 'utf-8'));
    const axes = (o.axes || []).filter((a) => (a.confidence || 0) >= 0.7).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
    const kw = [];
    for (const a of axes) (a.label + ' ' + a.left_pole + ' ' + a.right_pole).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4).forEach((w) => kw.push(w));
    return [...new Set(kw)];
  } catch { return []; }
}

/**
 * Build an async scorer: (post) -> relevance number. Guarded content -> -1.
 * LLM-driven (local qwen); keyword hits only tie-break equal-relevance posts.
 */
function makeScorer(keywords) {
  const { generate: llmGenerate } = require('../llm');
  return async (post) => {
    const text = (post.text || '').trim();
    if (!text) return -1;
    if (isSensitiveContent(text) || isSatireOrJoke(text)) return -1; // hard-skip

    const lower = text.toLowerCase();
    let hits = 0;
    for (const kw of keywords) if (lower.includes(kw)) hits++;

    let rel = 0;
    try {
      const raw = await llmGenerate(
        `You rate posts for Sebastian Hunter, who analyzes how narratives are constructed in public discourse: political messaging, media framing, propaganda, spin, institutional accountability, manipulation of public opinion.\n\n` +
        `Rate ONLY the substantive relevance to those themes. Greetings, blessings, motivational quotes, personal life, jokes, ads, and sports = 0 even if they mention people. A post must actually engage with power, politics, media, or truth-claims to score 2-3.\n\n` +
        `Answer with a SINGLE digit:\n0 = irrelevant, 1 = tangential mention, 2 = relevant, 3 = squarely on-topic.\n\n` +
        `POST: "${text.slice(0, 400)}"\n\nDigit:`,
        { temperature: 0, maxTokens: 5, timeoutMs: 30_000 }
      );
      const m = String(raw).match(/[0-3]/);
      rel = m ? Number(m[0]) : 0;
    } catch {
      rel = hits > 0 ? 1 : 0; // LLM down → fall back to lexical signal
    }
    return rel + Math.min(hits, 2) * 0.1;
  };
}

module.exports = { isSensitiveContent, isSatireOrJoke, loadAxisKeywords, makeScorer };
