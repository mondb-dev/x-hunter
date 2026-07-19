#!/usr/bin/env node
/**
 * runner/builder_vertex.js — builder-agent LLM caller (Claude or Vertex)
 *
 * Used by the META cycle builder agent and Telegram /builder ask command.
 * Historically Vertex-only (Gemini 2.5 Pro via BUILDER_CREDENTIALS — a separate
 * GCP service account keeping builder traffic isolated from the main pipeline).
 *
 * BUILDER_BACKEND=claude routes builder inference through the Claude CLI
 * (same `claude -p` mechanism as lib/compose.js COMPOSE/THINK backends), with
 * automatic fallback to the Vertex path on any Claude failure — a Claude
 * outage never blocks a build. Gated separately so compose/think/build toggle
 * independently.
 *
 * Exports:
 *   callBuilder(prompt, maxTokens, options) → Promise<string>
 *
 * options.thinkingBudget  — thinking token budget (Vertex path; default: 0)
 * options.model           — Vertex model override (default: BUILDER_MODEL env or gemini-2.5-pro)
 * options.claudeModel     — Claude alias/id (default: CLAUDE_BUILDER_MODEL env or 'sonnet')
 * options.fallback        — false → surface Claude errors instead of falling back (default true)
 *
 * Env: BUILDER_BACKEND=claude (or CLAUDE_BUILDER=1) enables the Claude path;
 *      CLAUDE_BUILDER_MODEL, CLAUDE_BUILDER_TIMEOUT_MS (default 600000 — builds
 *      emit up to ~16k tokens and can run minutes).
 */

"use strict";

const https = require("https");
const { getTokenForKey, getProjectConfig } = require("./gcp_auth");

const DEFAULT_MODEL = process.env.BUILDER_MODEL || "gemini-2.5-pro";

// Builder outputs are code/diffs/JSON consumed mechanically — same contract the
// Vertex path had, so the system prompt demands exact-format output only.
const BUILDER_SYSTEM =
  "You are a precise software-engineering engine for an autonomous agent's " +
  "self-modification builder. Follow the instructions in the user message " +
  "EXACTLY, including any required output format (unified diffs, full file " +
  "contents, or JSON). Output ONLY what is requested — no preamble, no " +
  "markdown code fences unless the instructions ask for them, no commentary " +
  "before or after. Honor every stated constraint.";

/** True when builder inference should route to the Claude terminal. */
function useClaudeBuilder() {
  const b = (process.env.BUILDER_BACKEND || "").toLowerCase();
  return b === "claude" || process.env.CLAUDE_BUILDER === "1";
}

/**
 * callBuilder(prompt, maxTokens, options)
 *
 * Routes to the Claude CLI when BUILDER_BACKEND=claude (falling back to Vertex
 * on failure), else calls Vertex AI using the builder service account.
 * Returns the trimmed text content string.
 */
async function callBuilder(prompt, maxTokens = 2000, options = {}) {
  if (useClaudeBuilder()) {
    try {
      const { claudeCompose } = require("./lib/compose");
      return await claudeCompose(prompt, {
        claudeModel: options.claudeModel || process.env.CLAUDE_BUILDER_MODEL || "sonnet",
        system: BUILDER_SYSTEM,
        timeoutMs: Number(process.env.CLAUDE_BUILDER_TIMEOUT_MS) || 600_000,
        tag: "builder",
      });
    } catch (e) {
      if (options.fallback === false) throw e;
      console.warn(`[builder] claude build failed (${e.message}) — falling back to Vertex`);
    }
  }

  const keyPath = process.env.BUILDER_CREDENTIALS;
  if (!keyPath) throw new Error("BUILDER_CREDENTIALS env var is not set");

  const token = await getTokenForKey(keyPath);
  const { project, location } = getProjectConfig();
  const model = options.model || DEFAULT_MODEL;

  const apiPath = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const thinkingBudget = options.thinkingBudget !== undefined ? options.thinkingBudget : 0;

  const generationConfig = { temperature: 0.7 };
  if (thinkingBudget > 0) {
    generationConfig.maxOutputTokens = maxTokens + thinkingBudget;
    generationConfig.thinkingConfig  = { thinkingBudget };
  } else {
    generationConfig.maxOutputTokens = maxTokens;
    generationConfig.thinkingConfig  = { thinkingBudget: 0 };
  }

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${location}-aiplatform.googleapis.com`,
      path: apiPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          const candidate = j?.candidates?.[0];
          const finishReason = candidate?.finishReason;
          if (finishReason === "MAX_TOKENS") {
            process.stderr.write("[builder_vertex] WARNING: response truncated (MAX_TOKENS)\n");
          }
          // Concatenate text parts, skipping thinking parts (thought: true)
          const parts = candidate?.content?.parts || [];
          const text = parts
            .filter(p => p.text !== undefined && !p.thought)
            .map(p => p.text)
            .join("");
          if (!text) throw new Error(`No content in response: ${raw.slice(0, 300)}`);
          try {
            const u = j?.usageMetadata || {};
            require('./lib/cost_meter').record({ tag: 'builder', model: options.model || DEFAULT_MODEL, inTokens: u.promptTokenCount, outTokens: u.candidatesTokenCount, promptChars: prompt.length, outChars: text.length });
          } catch {}
          resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { callBuilder, useClaudeBuilder };
