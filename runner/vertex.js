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

  const generationConfig = { temperature: 0.7, maxOutputTokens: maxTokens };
  if (options.thinkingBudget !== undefined && options.thinkingBudget > 0) {
    generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
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
          const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
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
