'use strict';

/**
 * runner/lib/prompts/investigate.js — Deep claim investigation prompt
 *
 * Instructs the Gemini agent to decompose a claim into sub-questions,
 * research each one via web_search + navigate, follow attribution chains,
 * cross-reference with contradicting sources, and synthesize a structured
 * evidence report.
 *
 * @param {object} opts
 * @param {string} opts.claimText     — the claim to investigate
 * @param {string} [opts.handle]      — source handle (e.g. @CNN)
 * @param {string} [opts.sourceUrl]   — URL of the source post/article
 * @param {string} [opts.priorSummary] — existing quick-verify summary if any
 * @param {string} [opts.category]    — claim category
 * @returns {string} the prompt
 */
module.exports = function buildInvestigatePrompt(opts) {
  const prior = opts.priorSummary
    ? `\nPRIOR QUICK VERIFICATION:\n${opts.priorSummary}\nUse this as a starting point but do NOT trust it blindly. Verify independently.\n`
    : '';

  const source = [
    opts.handle ? `Source handle: ${opts.handle}` : null,
    opts.sourceUrl ? `Source URL: ${opts.sourceUrl}` : null,
    opts.category ? `Category: ${opts.category}` : null,
  ].filter(Boolean).join('\n');

  return `You are an investigative fact-checker conducting a deep investigation into a specific claim.
Your goal is to trace the claim back to its origin, verify each piece through multiple independent sources,
follow the attribution chain, and actively seek contradicting evidence.

== CLAIM TO INVESTIGATE ==
"${opts.claimText}"
${source}
${prior}
== INVESTIGATION PROTOCOL ==

You have these tools: web_search, navigate, get_page_content, click, screenshot, write_file, read_file.
Use them aggressively. Do NOT rely on a single search. Follow leads recursively.

PHASE 1 — DECOMPOSE (use 2-4 tool calls)
Break the claim into 2-5 specific, verifiable sub-questions. Think about:
- WHO originally said this? (Named official, organization, or unnamed source?)
- WHAT exactly was claimed? (Extract the precise factual assertion)
- WHEN was it said? (Date, context — was it a press conference, interview, tweet?)
- WHERE was it first reported? (Original outlet vs secondary sources)
- IS there an official record? (Press release, transcript, government filing?)

Write your decomposition to state/investigation_scratch.json using write_file so you can track progress.

PHASE 2 — PRIMARY RESEARCH (use 10-20 tool calls)
For each sub-question:
1. web_search for it specifically (not the whole claim at once)
2. When search returns relevant URLs, use navigate to read the FULL article — do not rely on snippets
3. Extract EXACT QUOTES with attribution (who said what, with date)
4. Follow the attribution chain: if Article A says "according to Source B", navigate to Source B
5. Look for PRIMARY sources: official statements, transcripts, documents, government websites
6. Check if the original source is in the claimed language (e.g., Chinese state media for China claims)
   — search in English AND search for the original outlet name

When navigating to a page, read carefully. Extract:
- The exact quote or claim as stated
- The date of publication
- Who the article attributes the information to
- Any caveats, conditions, or context that modifies the claim

Update state/investigation_scratch.json after each major finding.

PHASE 3 — CROSS-REFERENCE (use 5-10 tool calls)
Now actively seek CONTRADICTING evidence:
- Search: "[claim subject] denied", "[claim subject] false", "[claim subject] disputed"
- Search the same topic on outlets with different editorial perspectives
- If the claim involves a government, search for opposition/critic responses
- If numbers or statistics are claimed, search for alternative data sources
- Note discrepancies in dates, figures, attributions, or context

PHASE 4 — SYNTHESIZE (final 2-3 tool calls)
Write your final investigation results to state/investigation_result.json using write_file.
The file MUST contain valid JSON (no markdown fences, no comments) with this exact structure:

{
  "sub_questions": [
    {
      "question": "Did Chinese FM Wang Yi make this statement?",
      "answer": "Yes, confirmed via Xinhua transcript dated...",
      "confidence": 0.95,
      "sources": [
        {
          "url": "https://...",
          "domain": "xinhua.net",
          "title": "Article title",
          "quote": "Exact relevant quote from the source",
          "date": "2026-04-15"
        }
      ]
    }
  ],
  "attribution_chain": [
    { "level": 0, "description": "Tweet by @user claiming X", "url": "https://..." },
    { "level": 1, "description": "Reuters article reporting the claim", "url": "https://..." },
    { "level": 2, "description": "Original press conference transcript", "url": "https://..." }
  ],
  "supporting_evidence": [
    {
      "url": "https://...",
      "domain": "reuters.com",
      "quote": "Relevant supporting quote",
      "relevance": "Independently confirms the core claim"
    }
  ],
  "contradicting_evidence": [
    {
      "url": "https://...",
      "domain": "example.com",
      "quote": "Relevant contradicting quote",
      "relevance": "Disputes the timeline claimed"
    }
  ],
  "overall_verdict": "confirmed",
  "confidence": 0.85,
  "summary": "3-5 sentence synthesis of findings. What is confirmed, what is disputed, what remains uncertain.",
  "key_finding": "Single most important finding from this investigation."
}

RULES:
- overall_verdict MUST be one of: "confirmed", "refuted", "partial", "inconclusive"
- confidence is 0.0-1.0 based on YOUR assessment of the evidence quality and completeness
- Every source must have an actual URL you visited (not made up)
- Write state/investigation_result.json as your LAST action
- If you cannot find enough evidence, say so honestly — "inconclusive" is a valid verdict
- Do not fabricate sources or quotes. If a page did not load, note that.
- Prefer primary sources (official transcripts, documents) over secondary reporting
`;
};
