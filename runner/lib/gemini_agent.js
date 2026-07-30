'use strict';

/**
 * runner/lib/gemini_agent.js — RETIRED.
 *
 * This was a 40-turn function-calling agent loop (Vertex/Gemini originally, then
 * Ollama's OpenAI-compatible endpoint). Both transports are gone under the
 * Claude-only inference policy, and `claude -p` is a single-shot text endpoint
 * with tools disabled — it cannot host this loop as-is.
 *
 * The module is kept as a fast-failing stub rather than deleted because every
 * caller ALREADY has a direct-compose fallback that runs when the agent fails to
 * produce a draft:
 *
 *   orchestrator.js TWEET  → compose_tweet.js
 *   orchestrator.js QUOTE  → compose_quote.js
 *   orchestrator.js BROWSE → single_pass_browse.js (now the only browse path)
 *   research.js            → its own callVertex path
 *   investigate_claim.js   → its own callVertex path
 *
 * Failing fast here means those fallbacks engage immediately instead of after a
 * wasted HTTP round-trip to a dead server. Rebuilding a real tool-calling loop
 * on Claude is separate work — see docs/INVENTORY.md → inference.
 *
 * Same exports as before: agentRun, agentRunSync.
 */

const RETIRED_MSG =
  'agent loop retired (Ollama/Gemini transports removed under the Claude-only ' +
  'policy) — caller should use its direct-compose fallback';

function log(msg) { console.log(`[gemini-agent] ${msg}`); }

/** Always rejects. Callers that awaited a transcript get a clear error. */
async function agentRun({ agent } = {}) {
  log(`${agent || 'agent'}: ${RETIRED_MSG}`);
  throw new Error(RETIRED_MSG);
}

/** Always returns a non-zero exit code, matching the old failure contract. */
function agentRunSync({ agent } = {}) {
  log(`${agent || 'agent'}: ${RETIRED_MSG}`);
  return 1;
}

module.exports = { agentRun, agentRunSync };
