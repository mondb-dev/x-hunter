#!/usr/bin/env node
/**
 * runner/vision.js — Gemini Flash multimodal helper via Vertex AI
 *
 * Exports:
 *   describeImage(base64, mimeType, context)  → Promise<string>   image description
 *   describeMedia(mediaItems)                 → Promise<Map>       batch describe
 *
 * Uses Vertex AI via service account (GOOGLE_APPLICATION_CREDENTIALS).
 * Sends image data as inlineData parts to Gemini Flash multimodal endpoint.
 *
 * Cost: ~258 tokens per image at Flash pricing.
 */

"use strict";

const { getAccessToken, getProjectConfig } = require("./gcp_auth");

const MODEL          = "gemini-2.5-flash";
const MAX_CONCURRENT = 3;
const TIMEOUT_MS     = 30_000;

/**
 * Describe a single image using Gemini Flash vision on Vertex AI.
 *
 * @param {string} base64 - base64-encoded image data
 * @param {string} mimeType - e.g. "image/png", "image/jpeg"
 * @param {string} [context=""] - optional tweet text for context
 * @returns {Promise<string|null>} description or null on error
 */
async function describeImage(base64, mimeType, context = "") {
  if (!base64 || !mimeType) return null;

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.warn(`[vision] auth error: ${err.message}`);
    return null;
  }
  const { project, location } = getProjectConfig();

  const contextNote = context
    ? `This image is attached to a tweet that says: "${context.slice(0, 300)}"\n\n`
    : "";

  const prompt = `${contextNote}Describe this image concisely in 1-2 sentences. Focus on: what is shown, any text visible in the image, and the key message or claim being made. If it's a chart or infographic, summarize the data. If it's a meme, describe the format and message. If it's a screenshot of text, transcribe the key content.`;

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${MODEL}:generateContent`;
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      signal:  controller.signal,
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 200,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[vision] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter(p => p.text !== undefined && !p.thought)
      .map(p => p.text)
      .join("");
    return text.trim() || null;
  } catch (err) {
    if (err.name !== "AbortError") {
      console.warn(`[vision] error: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Batch-describe media items with concurrency control.
 *
 * @param {Array<{postId: string, base64: string, mimeType: string, context: string, mediaType: string}>} items
 * @returns {Promise<Map<string, string>>} postId → description
 */
async function describeMedia(items) {
  const results = new Map();
  if (!items || items.length === 0) return results;

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
    const batch = items.slice(i, i + MAX_CONCURRENT);
    const promises = batch.map(async (item) => {
      const desc = await describeImage(item.base64, item.mimeType, item.context);
      if (desc) {
        const prefix = item.mediaType === "video" ? "[VIDEO] " : "[IMAGE] ";
        results.set(item.postId, prefix + desc);
      }
    });
    await Promise.all(promises);
  }

  return results;
}

module.exports = { describeImage, describeMedia };
