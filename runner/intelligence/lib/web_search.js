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
      'You are a fact-checker and claim analyst. Evaluate the following claim using current information.',
      '',
      `CLAIM: "${claimText}"`,
      '',
      'Search for evidence about this claim. Then respond with ONLY valid JSON (no markdown, no code fences):',
      '{',
      '  "verdict": "confirmed" | "refuted" | "partial" | "inconclusive" | "no_results",',
      '  "summary": "2-3 sentence explanation of findings",',
      '  "evidence_urls": ["url1", "url2"],',
      '  "supporting_sources_summary": "e.g. Reuters, AP News, and WHO confirm...",',
      '  "dissenting_sources_summary": "e.g. Some fringe outlets dispute...",',
      '  "original_source": "who first made or reported this claim",',
      '  "claim_date": "YYYY-MM-DD or YYYY-MM",',
      '  "framing_analysis": "Is the claim framed validly or misleadingly? 1-2 sentences."',
      '}',
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

      // Extract grounding URLs
      const grounding = data?.candidates?.[0]?.groundingMetadata;
      const groundingUrls = (grounding?.groundingChunks || [])
        .filter(c => c.web?.uri)
        .map(c => c.web.uri);

      // Parse structured response
      let parsed;
      try {
        let clean = text.replace(/```json\s*\n?/gi, '').replace(/```\s*/g, '').trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) clean = jsonMatch[0];
        parsed = JSON.parse(clean);
      } catch {
        log(`failed to parse response: ${text.slice(0, 200)}`);
        // Salvage fields from malformed JSON using regex
        const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const verdictMatch = text.match(/"verdict"\s*:\s*"(\w+)"/);
        const frameMatch = text.match(/"framing_analysis"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const supportMatch = text.match(/"supporting_sources_summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const dissentMatch = text.match(/"dissenting_sources_summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);

        const verdictMap = { confirmed: 'confirmed', refuted: 'refuted', partial: 'partial' };
        return {
          web_search_result: verdictMatch ? (verdictMap[verdictMatch[1]] || 'inconclusive') : 'inconclusive',
          summary: summaryMatch
            ? summaryMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"')
            : text.replace(/```json\s*/gi, '').replace(/```/g, '').trim().slice(0, 500),
          evidence_urls: groundingUrls,
          original_source: null,
          claim_date: null,
          supporting_sources: supportMatch ? [{ name: supportMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'), stance: '' }] : [],
          dissenting_sources: dissentMatch ? [{ name: dissentMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'), stance: '' }] : [],
          framing_analysis: frameMatch ? frameMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : null,
        };
      }

      const verdictMap = {
        confirmed: 'confirmed', refuted: 'refuted', partial: 'partial',
        inconclusive: 'inconclusive', no_results: 'no_results',
      };

      return {
        web_search_result:  verdictMap[parsed.verdict] || 'inconclusive',
        summary:            parsed.summary || '',
        evidence_urls:      [...new Set([...(parsed.evidence_urls || []), ...groundingUrls])].slice(0, 5),
        original_source:    parsed.original_source || null,
        claim_date:         parsed.claim_date || null,
        supporting_sources: parsed.supporting_sources_summary ? [{ name: parsed.supporting_sources_summary, stance: '' }] : [],
        dissenting_sources: parsed.dissenting_sources_summary ? [{ name: parsed.dissenting_sources_summary, stance: '' }] : [],
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
