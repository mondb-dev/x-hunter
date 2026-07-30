/**
 * runner/intelligence/lib/web_search.js — web search verification via the
 * HelmStack browser session + Claude summarization.
 *
 * The Vertex/Gemini "Google Search grounding" path (and its BUILDER_CREDENTIALS
 * service account) is gone: Claude is the only model, and it has no search
 * grounding, so real browser results are the only evidence source.
 *
 * Exports:
 *   webSearchVerify(claimText) → Promise<SearchResult | null>
 */

'use strict';

function log(msg) { console.log(`[web_search] ${msg}`); }

/**
 * @typedef {Object} SearchResult
 * @property {string} web_search_result - confirmed|refuted|partial|inconclusive|no_results
 * @property {string} summary
 * @property {string[]} evidence_urls
 * @property {string|null} original_source
 * @property {string|null} claim_date
 * @property {Array} supporting_sources
 * @property {Array} dissenting_sources
 * @property {string|null} framing_analysis
 */

/**
 * Claim verification: HelmStack browser search + LLM summarization.
 * evidence_urls come from the real search results, not the LLM.
 *
 * Search runs through the HelmStack browser session (lib/helmstack_fetch) rather
 * than the legacy CDP Chrome: HelmStack is the session the rest of the system
 * already drives, and the old path scraped Bing through headless Chrome, which
 * is the more bot-blocked surface. Falls back to the CDP scraper if HelmStack
 * returns nothing, so a HelmStack outage degrades rather than blanks verification.
 */
async function webSearchVerify(claimText) {
  try {
    const { searchWeb } = require('../../lib/helmstack_fetch');
    const { browserSearch } = require('../../lib/browser_search');
    const { callVertex } = require('../../vertex'); // Claude (compat shim)

    let results = await searchWeb(claimText, { max: 6 });
    if (!results.length) {
      results = await browserSearch(claimText, { maxResults: 6 }).catch(() => []);
    }
    const empty = {
      web_search_result: 'no_results', summary: 'No web results found.',
      evidence_urls: [], evidence_domains: [], original_source: null, claim_date: null,
      supporting_sources: [], dissenting_sources: [], framing_analysis: null,
    };
    if (!results.length) return empty;

    const evidence_urls = results.map(r => r.url).slice(0, 5);
    const evidence_domains = results
      .map(r => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return null; } })
      .filter(Boolean).slice(0, 5);

    const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    const prompt = [
      'You are a fact-checker. Using ONLY the search results below, evaluate the claim.',
      '',
      `CLAIM: "${claimText}"`,
      '',
      'SEARCH RESULTS:',
      context,
      '',
      'Respond with ONLY a JSON object (no markdown fences, no extra text):',
      '{"verdict":"confirmed|refuted|partial|inconclusive|no_results",',
      '"summary":"2-3 sentence findings",',
      '"supporting_sources":[{"name":"Outlet/org name","excerpt":"1 sentence of what they reported"}],',
      '"dissenting_sources":[{"name":"Outlet/org name","excerpt":"1 sentence of what they reported"}],',
      '"original_source":"who first reported this claim",',
      '"claim_date":"YYYY-MM-DD or YYYY-MM if known, else empty",',
      '"framing_analysis":"Is the claim framed validly or misleadingly? 1-2 sentences."}',
    ].join('\n');

    // Judgement runs on the Gemini WEB APP through the signed-in HelmStack
    // browser session — no API key, no per-token billing (distinct from the
    // retired Vertex/Gemini API). A frontier model reading real search results
    // beats the local 7B, which was scoring well-sourced true claims as
    // "refuted" around 0.45 and dragging research confidence into "compromised".
    // Falls back to the local brain so verification degrades rather than blanks.
    let text = null;
    try {
      const { HelmStackClient, Gemini } = require('../../../tools/helmstack-social/src');
      text = await new Gemini(new HelmStackClient()).ask(prompt, { timeoutMs: 90_000 });
    } catch (e) {
      console.warn(`[web_search] gemini web app unavailable (${e.message}) — falling back to local`);
    }
    if (!text || !String(text).trim()) text = await callVertex(prompt, 1000, { temperature: 0.1 });

    let parsed = {};
    try {
      let clean = text.replace(/```json\s*\n?/gi, '').replace(/```\s*/g, '').trim();
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) clean = m[0];
      parsed = JSON.parse(clean);
    } catch { log('local verify: JSON parse failed, using summary fallback'); }

    const verdictMap = {
      confirmed: 'confirmed', refuted: 'refuted', partial: 'partial',
      inconclusive: 'inconclusive', no_results: 'no_results',
    };
    const norm = (raw) => Array.isArray(raw)
      ? raw.map(s => typeof s === 'string' ? { name: s, excerpt: '', url: null } : { name: s.name || '', excerpt: s.excerpt || s.stance || '', url: null }).filter(s => s.name)
      : [];

    return {
      web_search_result:  verdictMap[parsed.verdict] || 'inconclusive',
      summary:            parsed.summary || (text || '').slice(0, 500),
      evidence_urls,
      evidence_domains,
      original_source:    parsed.original_source || null,
      claim_date:         parsed.claim_date || null,
      supporting_sources: norm(parsed.supporting_sources),
      dissenting_sources: norm(parsed.dissenting_sources),
      framing_analysis:   parsed.framing_analysis || null,
    };
  } catch (err) {
    log(`local verify error: ${err.message}`);
    return null;
  }
}

module.exports = { webSearchVerify };
