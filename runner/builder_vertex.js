#!/usr/bin/env node
/**
 * runner/builder_vertex.js — builder-agent LLM caller. Claude only.
 *
 * Used by the META cycle builder agent and Telegram /builder ask command.
 * Historically Vertex-only (Gemini 2.5 Pro via a separate BUILDER_CREDENTIALS
 * service account); the Vertex transport and that service account are gone with
 * the rest of the Gemini stack. The filename is kept so callers need no edits.
 *
 * INFERENCE POLICY: Claude is the only LLM. There is no fallback backend — a
 * build that cannot reach Claude fails loudly rather than silently dropping to
 * a different model that writes different code.
 *
 * Exports:
 *   callBuilder(prompt, maxTokens, options) → Promise<string>
 *
 * options.claudeModel  — Claude alias/id (default: CLAUDE_BUILDER_MODEL or 'sonnet')
 * options.timeoutMs    — per-attempt kill timeout (default CLAUDE_BUILDER_TIMEOUT_MS)
 *
 * Env: CLAUDE_BUILDER_MODEL, CLAUDE_BUILDER_TIMEOUT_MS (default 600000 — builds
 *      emit up to ~16k tokens and can run minutes).
 */

"use strict";

const { claudeCompose, withRetry } = require("./lib/compose");

// Builder outputs are code/diffs/JSON consumed mechanically — same contract the
// Vertex path had, so the system prompt demands exact-format output only.
const BUILDER_SYSTEM =
  "You are a precise software-engineering engine for an autonomous agent's " +
  "self-modification builder. Follow the instructions in the user message " +
  "EXACTLY, including any required output format (unified diffs, full file " +
  "contents, or JSON). Output ONLY what is requested — no preamble, no " +
  "markdown code fences unless the instructions ask for them, no commentary " +
  "before or after. Honor every stated constraint.";

/** @deprecated Claude is the only inference backend — always true. */
function useClaudeBuilder() { return true; }

/**
 * callBuilder(prompt, maxTokens, options)
 *
 * Generates via Claude, retrying transient failures. Returns trimmed text.
 * maxTokens is accepted and ignored — `claude -p` has no output cap to set.
 */
async function callBuilder(prompt, maxTokens = 2000, options = {}) {
  return withRetry(() => claudeCompose(prompt, {
    claudeModel: options.claudeModel || process.env.CLAUDE_BUILDER_MODEL || "sonnet",
    system: options.system || BUILDER_SYSTEM,
    timeoutMs: options.timeoutMs || Number(process.env.CLAUDE_BUILDER_TIMEOUT_MS) || 600_000,
    tag: "builder",
  }), "builder");
}

module.exports = { callBuilder, useClaudeBuilder };
