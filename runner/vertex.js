#!/usr/bin/env node
/**
 * runner/vertex.js — Vertex AI Gemini Pro caller
 *
 * Shared by generate_checkpoint.js, ponder.js, write_article.js, etc.
 * Uses shared gcp_auth.js for OAuth2 token management.
 *
 * No external dependencies — uses only Node.js built-ins (https).
 */

"use strict";

const https = require("https");
const { getAccessToken, getProjectConfig } = require("./gcp_auth");

/**
 * callVertex(prompt, maxTokens, options)
 *
 * Calls Vertex AI with the given prompt.
 * Returns the text content string.
 *
 * options.model         - model ID (default: gemini-2.5-flash)
 * options.thinkingBudget - if set and > 0, sets thinking token budget
 */
async function callVertex(prompt, maxTokens = 2000, options = {}) {
  const token    = await getAccessToken();
  const { project, location } = getProjectConfig();
  const model    = options.model || "gemini-2.5-flash";

  const apiPath  = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  // Thinking tokens share the maxOutputTokens budget in Gemini 2.5.
  // To preserve the caller's full response budget, add the thinking budget on top.
  const DEFAULT_THINKING_BUDGET = 1024;
  const thinkingBudget = options.thinkingBudget !== undefined
    ? options.thinkingBudget
    : DEFAULT_THINKING_BUDGET;

  const generationConfig = { temperature: 0.7 };
  if (thinkingBudget > 0) {
    generationConfig.maxOutputTokens = maxTokens + thinkingBudget;
    generationConfig.thinkingConfig = { thinkingBudget };
  } else {
    generationConfig.maxOutputTokens = maxTokens;
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const body     = JSON.stringify({
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
            process.stderr.write("[vertex] WARNING: response truncated (MAX_TOKENS)\n");
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

module.exports = { callVertex };
