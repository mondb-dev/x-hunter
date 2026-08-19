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
 * The score is an LLM relevance rating 0-3 (+ a small keyword-hit tie-breaker);
 * guarded content returns -1. Same rubric x_engage has always used.
 *
 * NOTE: inference is the Claude CLI (a subprocess), not the old local model, so
 * a scorer is SLOW and callers must not fan it out across a whole timeline —
 * engage() bounds the concurrency for exactly this reason.
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

const SCORER_PROMPT = (text) =>
  `You rate posts for Sebastian Hunter, who analyzes how narratives are constructed in public discourse: political messaging, media framing, propaganda, spin, institutional accountability, manipulation of public opinion.\n\n` +
  `Rate ONLY the substantive relevance to those themes. Greetings, blessings, motivational quotes, personal life, jokes, ads, and sports = 0 even if they mention people. A post must actually engage with power, politics, media, or truth-claims to score 2-3.\n\n` +
  `Answer with a SINGLE digit:\n0 = irrelevant, 1 = tangential mention, 2 = relevant, 3 = squarely on-topic.\n\n` +
  `POST: "${String(text).slice(0, 400)}"\n\nDigit:`;

/**
 * Build an async scorer: (post) -> relevance number. Guarded content -> -1.
 * LLM-driven; keyword hits only tie-break equal-relevance posts.
 *
 * BACKEND: this is bounded classification (one digit), the one shape a small
 * local model handles as well as a frontier one — so when LOCAL_LLM_ENABLED=1
 * and the model is actually pulled, scoring routes to Ollama (lib/local_llm.js):
 * ~free, and fast enough to matter (the Claude CLI path needed a 90s timeout
 * because a subprocess "cannot answer that fast under any load", and that is
 * paid per candidate post, every cycle, on both X and LinkedIn).
 *
 * The routing is decided ONCE per scorer, not per post, and a local failure
 * degrades to the lexical signal — it never escalates to Claude. Chaining
 * backends per call is exactly what produced "Claude 429s -> local 404s ->
 * retry -> 18 failures in one cycle" on 2026-07-30 (b158bd33a).
 *
 * @param {string[]} keywords
 * @param {object} [opts]
 * @param {(m:string)=>void} [opts.log] one-line backend report (which backend, and why)
 */
function makeScorer(keywords, { log } = {}) {
  const { generate: llmGenerate } = require('../llm');
  const local = require('./local_llm');

  // Resolved lazily on first use, then cached: one availability probe per run.
  // Cache the in-flight PROMISE, not the resolved value: scoring is bounded-
  // concurrent, so caching only the result lets N scorers all miss the cache and
  // each run their own warm-up (observed: 3 concurrent probes, ~6s each).
  let routePromise = null;
  function resolveRoute() {
    if (routePromise) return routePromise;
    routePromise = (async () => {
      let route;
      if (!local.isEnabled()) { route = { local: false, why: 'local disabled' }; }
      else {
        const av = await local.isAvailable(); // warms the model (~110s cold)
        // A missing model is REPORTED, never silent — the 2026-07-28 wipe went
        // unnoticed for 2.3 days precisely because absence looked like normal output.
        route = av.ok
          ? { local: true, mode: local.mode(), why: `${local.MODEL} ready in ${av.warmedMs}ms, mode=${local.mode()}` }
          : { local: false, why: `local unavailable (${av.reason})` };
      }
      if (log) log(`relevance backend: ${route.local ? 'local' : 'claude'} — ${route.why}`);
      return route;
    })();
    return routePromise;
  }

  const digit = (raw) => { const m = String(raw).match(/[0-3]/); return m ? Number(m[0]) : 0; };

  return async (post) => {
    const text = (post.text || '').trim();
    if (!text) return -1;
    if (isSensitiveContent(text) || isSatireOrJoke(text)) return -1; // hard-skip

    const lower = text.toLowerCase();
    let hits = 0;
    for (const kw of keywords) if (lower.includes(kw)) hits++;

    const r = await resolveRoute();

    if (r.local) {
      let localScore = null;
      try {
        localScore = digit(await local.generateLocal(SCORER_PROMPT(text), {
          temperature: 0, maxTokens: 4, timeoutMs: 20_000, tag: 'relevance', stop: ['\n'],
        }));
      } catch {
        // 'only' has no second backend by design (never escalate to Claude —
        // that chaining caused the 2026-07-30 cascade); degrade to lexical.
        if (r.mode === 'only') return (hits > 0 ? 1 : 0) + Math.min(hits, 2) * 0.1;
      }
      if (localScore !== null) {
        if (r.mode === 'only') return localScore + Math.min(hits, 2) * 0.1;
        // prefilter: a local 0 is the one call this model makes reliably.
        if (localScore === 0) return 0 + Math.min(hits, 2) * 0.1;
      }
    }

    let rel = 0;
    try {
      const raw = await llmGenerate(
        // Same SCORER_PROMPT both backends use — keeping one copy is what makes
        // a local-vs-Claude agreement measurement meaningful.
        SCORER_PROMPT(text),
        // 30s was sized for the old local qwen brain. Inference is now the Claude
        // CLI (a subprocess), which cannot answer that fast under any load — the
        // scorer was falling through to the lexical branch on every call.
        { temperature: 0, maxTokens: 5, timeoutMs: 90_000 }
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
