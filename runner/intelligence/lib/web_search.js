/**
 * runner/intelligence/lib/web_search.js — web search verification via Gemini + Google Search
 *
 * Uses BUILDER_CREDENTIALS (separate SA) to avoid rate-limit contention
 * with the browse/synthesize pipeline.
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
 * Use Vertex AI with Google Search grounding to verify a claim.
 * @param {string} claimText
 * @returns {Promise<SearchResult|null>}
 */
async function webSearchVerify(claimText) {
  try {
    const { getTokenForKey, getProjectConfig } = require('../../gcp_auth');
    const builderKey = process.env.BUILDER_CREDENTIALS;
    if (!builderKey) throw new Error('BUILDER_CREDENTIALS not set');

    const token = await getTokenForKey(builderKey);
    const { project, location } = getProjectConfig();

    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`;

    const prompt = [
      'You are a fact-checker. Evaluate the following claim using current information.',
      '',
      `CLAIM: "${claimText}"`,
      '',
      'Search for evidence. Respond with ONLY a JSON object (no markdown fences, no extra text):',
      '{"verdict":"confirmed|refuted|partial|inconclusive|no_results",',
      '"summary":"2-3 sentence findings",',
      '"supporting_sources":"Name the outlets/orgs that support this claim, e.g. Reuters, AP News confirm X",',
      '"dissenting_sources":"Name outlets/orgs that contradict this, or empty string if none",',
      '"original_source":"who first reported this claim",',
      '"claim_date":"YYYY-MM-DD or YYYY-MM if known, else empty",',
      '"framing_analysis":"Is the claim framed validly or misleadingly? 1-2 sentences."}',
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        log(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        return null;
      }

      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');

      // Extract grounding metadata — keep redirect URIs (they resolve to real pages)
      // and extract domain/title for source attribution
      const grounding = data?.candidates?.[0]?.groundingMetadata;
      const groundingChunks = (grounding?.groundingChunks || []).filter(c => c.web?.uri);
      const groundingUrls = groundingChunks.map(c => c.web.uri);
      const groundingDomains = groundingChunks
        .map(c => c.web.domain || c.web.title || null)
        .filter(Boolean);
      const searchQueries = grounding?.webSearchQueries || [];

      // Parse structured response
      let parsed;
      try {
        let clean = text.replace(/```json\s*\n?/gi, '').replace(/```\s*/g, '').trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) clean = jsonMatch[0];
        parsed = JSON.parse(clean);
      } catch {
        log(`failed to parse JSON, using regex fallback`);
        const rx = (key) => {
          const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's'));
          return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : null;
        };
        const verdict = rx('verdict');
        const verdictMap = { confirmed: 'confirmed', refuted: 'refuted', partial: 'partial' };
        return {
          web_search_result: verdict ? (verdictMap[verdict] || 'inconclusive') : 'inconclusive',
          summary: rx('summary') || text.replace(/```json\s*/gi, '').replace(/```/g, '').trim().slice(0, 500),
          evidence_urls: groundingUrls,
          evidence_domains: groundingDomains,
          original_source: rx('original_source'),
          claim_date: rx('claim_date'),
          supporting_sources: rx('supporting_sources') ? [{ name: rx('supporting_sources'), stance: '' }] : [],
          dissenting_sources: rx('dissenting_sources') ? [{ name: rx('dissenting_sources'), stance: '' }] : [],
          framing_analysis: rx('framing_analysis'),
        };
      }

      const verdictMap = {
        confirmed: 'confirmed', refuted: 'refuted', partial: 'partial',
        inconclusive: 'inconclusive', no_results: 'no_results',
      };

      return {
        web_search_result:  verdictMap[parsed.verdict] || 'inconclusive',
        summary:            parsed.summary || '',
        evidence_urls:      groundingUrls.slice(0, 5),
        evidence_domains:   groundingDomains.slice(0, 5),
        original_source:    parsed.original_source || null,
        claim_date:         parsed.claim_date || null,
        supporting_sources: parsed.supporting_sources ? [{ name: parsed.supporting_sources, stance: '' }] : [],
        dissenting_sources: parsed.dissenting_sources ? [{ name: parsed.dissenting_sources, stance: '' }] : [],
        framing_analysis:   parsed.framing_analysis || null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log(`error: ${err.message}`);
    return null;
  }
}

module.exports = { webSearchVerify };
