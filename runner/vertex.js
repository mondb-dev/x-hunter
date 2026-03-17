#!/usr/bin/env node
/**
 * runner/vertex.js — Vertex AI Gemini caller (service account auth)
 *
 * Shared by generate_checkpoint.js, ponder.js, write_article.js.
 * Uses the service account JSON at GOOGLE_APPLICATION_CREDENTIALS to mint
 * a short-lived OAuth2 bearer token, then calls the Vertex AI generateContent
 * endpoint with gemini-2.5-pro.
 *
 * No external dependencies — uses only Node.js built-ins (crypto, https).
 */

"use strict";

const fs     = require("fs");
const https  = require("https");
const crypto = require("crypto");
const path   = require("path");

const ROOT = path.resolve(__dirname, "..");

// Load .env if not already loaded
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// Cache the token in memory for the process lifetime
let _cachedToken = null;
let _tokenExpiry = 0;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss:   serviceAccount.client_email,
    sub:   serviceAccount.client_email,
    aud:   "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    iat:   now,
    exp:   now + 3600,
  })));
  const unsigned = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const sig = base64url(sign.sign(serviceAccount.private_key));
  return `${unsigned}.${sig}`;
}

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) throw new Error("GOOGLE_APPLICATION_CREDENTIALS not set");
  const sa = JSON.parse(fs.readFileSync(keyPath, "utf-8"));

  const jwt  = makeJwt(sa);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          if (!j.access_token) throw new Error(`Token exchange failed: ${raw.slice(0, 200)}`);
          _cachedToken = j.access_token;
          _tokenExpiry = Date.now() + (j.expires_in - 60) * 1000;
          resolve(_cachedToken);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * callVertex(prompt, maxTokens, options)
 *
 * Calls Vertex AI gemini-2.5-pro with the given prompt.
 * Returns the text content string.
 *
 * options.thinkingBudget - if set, limits thinking tokens (0 = disable thinking)
 */
async function callVertex(prompt, maxTokens = 2000, options = {}) {
  const token    = await getAccessToken();
  const project  = process.env.VERTEX_PROJECT_ID || "sebastian-hunter";
  const location = process.env.VERTEX_LOCATION   || "us-central1";
  const model    = "gemini-2.5-pro";

  const apiPath  = `/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const generationConfig = { temperature: 0.7, maxOutputTokens: maxTokens };
  if (options.thinkingBudget !== undefined) {
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
