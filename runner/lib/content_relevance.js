'use strict';
/**
 * runner/lib/content_relevance.js — shared relevance scoring + content guards for
 * outbound engagement (x_engage replies, x_amplify, linkedin_engage). Extracted
 * so those paths share one scorer instead of drifting copies.
 *
 *   isSensitiveContent(text) / isSatireOrJoke(text)  hard-skip guards
 *   loadAxisKeywords()                               belief-axis vocabulary (tie-break)
 *   makeScorer(keywords)                             async (post) -> number, with .stats
 *   scoreLimit(fn) / SCORE_TIMEOUT_MS                shared LLM call budget
 *
 * The score is an LLM relevance rating 0-3 (+ a small keyword-hit tie-breaker);
 * guarded content and unscorable posts return -1. Same rubric x_engage has
 * always used.
 *
 * CALL BUDGET. Scoring runs through Claude's CLI (one subprocess per call, ~5s
 * warm), and the engines score a whole scraped batch with Promise.all. Unbounded
 * that meant ~25 concurrent `claude -p` spawns racing a 30s timeout inherited
 * from the retired local brain: every call timed out, every post scored 0, and
 * linkedin_engage logged a clean "0 relevant" for two months (2026-07-05 →
 * 2026-08-08). Measured on the runner host: 1 call 5.2s, 8 concurrent 27.6s. So
 * calls are funnelled through one process-wide semaphore and given a timeout
 * with real headroom.
 */

const fs = require('fs');
const path = require('path');

const ONTOLOGY = path.join(path.resolve(__dirname, '..', '..'), 'state', 'ontology.json');

// Per-call kill timeout and max concurrent scoring calls. See CALL BUDGET above.
const SCORE_TIMEOUT_MS = Number.parseInt(process.env.RELEVANCE_TIMEOUT_MS || '', 10) || 90_000;
const SCORE_CONCURRENCY = Number.parseInt(process.env.RELEVANCE_CONCURRENCY || '', 10) || 4;

/** Semaphore: run at most `max` tasks at once, queueing the rest FIFO. */
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const release = () => { active--; const run = queue.shift(); if (run) run(); };
  return (fn) => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(fn).then(
        (v) => { release(); resolve(v); },
        (e) => { release(); reject(e); },
      );
    };
    if (active < max) run(); else queue.push(run);
  });
}

// One pool per process, shared by every scorer built here and in linkedin_engage,
// so a single engine run cannot fan out past SCORE_CONCURRENCY.
const scoreLimit = makeLimiter(SCORE_CONCURRENCY);

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
 * LLM-driven; keyword hits only tie-break equal-relevance posts.
 *
 * A scoring call that fails returns -1 (skip), not 0, and is counted on
 * `scorer.stats.failed` — a 0 is a judgement ("irrelevant") and an outage must
 * not be able to impersonate one. Callers should log the counter so a dead
 * backend reads as a warning instead of a plausible "nothing was relevant".
 */
function makeScorer(keywords) {
  const { generate: llmGenerate } = require('../llm');
  const stats = { scored: 0, failed: 0 };

  const scorer = async (post) => {
    const text = (post.text || '').trim();
    if (!text) return -1;
    if (isSensitiveContent(text) || isSatireOrJoke(text)) return -1; // hard-skip

    const lower = text.toLowerCase();
    let hits = 0;
    for (const kw of keywords) if (lower.includes(kw)) hits++;

    let rel = 0;
    try {
      const raw = await scoreLimit(() => llmGenerate(
        `You rate posts for Sebastian Hunter, who analyzes how narratives are constructed in public discourse: political messaging, media framing, propaganda, spin, institutional accountability, manipulation of public opinion.\n\n` +
        `Rate ONLY the substantive relevance to those themes. Greetings, blessings, motivational quotes, personal life, jokes, ads, and sports = 0 even if they mention people. A post must actually engage with power, politics, media, or truth-claims to score 2-3.\n\n` +
        `Answer with a SINGLE digit:\n0 = irrelevant, 1 = tangential mention, 2 = relevant, 3 = squarely on-topic.\n\n` +
        `POST: "${text.slice(0, 400)}"\n\nDigit:`,
        { temperature: 0, maxTokens: 5, timeoutMs: SCORE_TIMEOUT_MS }
      ));
      const m = String(raw).match(/[0-3]/);
      rel = m ? Number(m[0]) : 0;
      stats.scored++;
    } catch (err) {
      stats.failed++;
      stats.lastError = err.message;
      return -1; // unscorable → skip, never engage on a guessed score
    }
    return rel + Math.min(hits, 2) * 0.1;
  };

  scorer.stats = stats;
  return scorer;
}

module.exports = {
  isSensitiveContent, isSatireOrJoke, loadAxisKeywords, makeScorer,
  scoreLimit, SCORE_TIMEOUT_MS, SCORE_CONCURRENCY,
};
