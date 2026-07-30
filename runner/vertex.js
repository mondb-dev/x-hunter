#!/usr/bin/env node
/**
 * runner/vertex.js — compatibility shim. The name is historical (this was the
 * Vertex/Gemini caller, then the local-Ollama caller); the transport is now
 * Claude, like everything else.
 *
 * INFERENCE POLICY: Claude is the only LLM. Gemini/Vertex was retired first, the
 * local Ollama brain second. This module exists solely so the ~16 legacy callers
 * of callVertex() keep working unchanged; new code should require lib/compose.js
 * and call compose() or reason() directly.
 *
 * It delegates to claudeCompose() rather than compose() on purpose: compose()
 * used to fall back HERE, and routing this through it would be circular.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

"use strict";

const { claudeCompose, withRetry, REASON_SYSTEM } = require("./lib/compose");

/**
 * callVertex(prompt, maxTokens, options)
 *
 * Generates text via Claude. Returns the text content string.
 *
 * The maxTokens argument is accepted and ignored — `claude -p` has no output
 * token cap to set, and every caller passed it as a budget hint rather than a
 * hard requirement. It is kept in the signature so callers need no edits.
 *
 * options.temperature - accepted and ignored (no CLI equivalent)
 * options.tag         - cost-meter label (default: "brain")
 * options.system      - system prompt override (default: REASON_SYSTEM)
 * options.timeoutMs   - per-attempt kill timeout
 */
async function callVertex(prompt, maxTokens = 2000, options = {}) {
  const tag = options.tag || "brain";
  const out = await withRetry(() => claudeCompose(prompt, {
    system:      options.system || REASON_SYSTEM,
    claudeModel: options.claudeModel,
    timeoutMs:   options.timeoutMs,
    tag,
  }), tag);
  // claudeCompose already records token-accurate usage; this second record would
  // double-count, so cost accounting lives there and not here.
  return out;
}

module.exports = { callVertex };
