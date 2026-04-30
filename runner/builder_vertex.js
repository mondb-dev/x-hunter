#!/usr/bin/env node
/**
 * runner/builder_vertex.js — Vertex AI caller using BUILDER_CREDENTIALS
 *
 * Used by the META cycle builder agent and Telegram /builder ask command.
 * Uses a separate GCP service account (BUILDER_CREDENTIALS) to keep
 * builder traffic isolated from the main browse/synthesize pipeline.
 *
 * Exports:
 *   callBuilder(prompt, maxTokens, options) → Promise<string>
 *
 * options.thinkingBudget  — thinking token budget (default: 0)
 * options.model           — model override (default: BUILDER_MODEL env or gemini-2.5-pro)
 */

"use strict";

const https = require("https");
const { getTokenForKey, getProjectConfig } = require("./gcp_auth");

const DEFAULT_MODEL = process.env.BUILDER_MODEL || "gemini-2.5-pro";

/**
 * callBuilder(prompt, maxTokens, options)
 *
 * Calls Vertex AI using the builder service account.
 * Returns the trimmed text content string.
 */
async function callBuilder(prompt, maxTokens = 2000, options = {}) {
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
          resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { callBuilder };
