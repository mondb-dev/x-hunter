#!/usr/bin/env node
/**
 * runner/builder_vertex.js — Vertex AI caller for the builder agent
 *
 * Uses BUILDER_CREDENTIALS (separate service account) and BUILDER_MODEL
 * to call Gemini 2.5 Pro for code generation tasks.
 *
 * Auth is delegated to gcp_auth.getTokenForKey() so JWT logic lives in
 * one place. The builder gets its own per-key token cache, keeping its
 * quota and audit trail separate from the main service account.
 */

"use strict";

const https = require("https");
const { getTokenForKey, getProjectConfig } = require("./gcp_auth");

// ── Vertex AI call ──────────────────────────────────────────────────────────

/**
 * callBuilder(prompt, maxTokens, options)
 *
 * Calls Vertex AI with builder credentials + model.
 * Returns the text content string.
 *
 * options.thinkingBudget  - thinking token limit (0 = disable)
 * options.temperature     - defaults to 0.3 (lower than observation — we want precise code)
 */
async function callBuilder(prompt, maxTokens = 8192, options = {}) {
  const keyPath = process.env.BUILDER_CREDENTIALS;
  if (!keyPath) throw new Error("BUILDER_CREDENTIALS not set in .env");

  const token            = await getTokenForKey(keyPath);
  const { project, location } = getProjectConfig();
  const model            = process.env.BUILDER_MODEL || "gemini-2.5-pro";

  const apiPath = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const generationConfig = {
    temperature:     options.temperature ?? 0.3,
    maxOutputTokens: maxTokens,
  };
  if (options.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
  }

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${location}-aiplatform.googleapis.com`,
      path:     apiPath,
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          const text = j?.candidates?.[0]?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join("")
            ?.trim();
          if (!text) throw new Error(`No content in builder response: ${raw.slice(0, 300)}`);
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { callBuilder };
