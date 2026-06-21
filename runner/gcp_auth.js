#!/usr/bin/env node
/**
 * runner/gcp_auth.js — Shared GCP service-account auth for Vertex AI
 *
 * Exports:
 *   getAccessToken()   → Promise<string>   short-lived OAuth2 bearer token
 *   getProjectConfig() → { project, location }
 *
 * Uses GOOGLE_APPLICATION_CREDENTIALS for the service account JSON path.
 * Token is cached in memory and refreshed ~60s before expiry.
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

// Per-key token cache: keyPath → { token, expiry }
const _tokenCache = new Map();

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

/**
 * Get an access token for a specific service account key file.
 * Tokens are cached per key path and refreshed ~60s before expiry.
 *
 * @param {string} keyPath - absolute path to a GCP service account JSON
 */
async function getTokenForKey(keyPath) {
  if (!keyPath) throw new Error("keyPath is required for getTokenForKey");

  const cached = _tokenCache.get(keyPath);
  if (cached && Date.now() < cached.expiry) return cached.token;

  const sa  = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  const jwt = makeJwt(sa);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  { "Content-Type": "application/x-www-form-urlencoded" },
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(raw);
          if (!j.access_token) throw new Error(`Token exchange failed: ${raw.slice(0, 200)}`);
          _tokenCache.set(keyPath, {
            token:  j.access_token,
            expiry: Date.now() + (j.expires_in - 60) * 1000,
          });
          resolve(j.access_token);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Get an access token using the default GOOGLE_APPLICATION_CREDENTIALS.
 * Delegates to getTokenForKey — single code path for all token exchange.
 */
async function getAccessToken() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) throw new Error("GOOGLE_APPLICATION_CREDENTIALS not set");
  return getTokenForKey(keyPath);
}

function getProjectConfig() {
  return {
    project:  process.env.VERTEX_PROJECT_ID || "sebastian-hunter",
    location: process.env.VERTEX_LOCATION   || "us-central1",
  };
}

module.exports = { getAccessToken, getTokenForKey, getProjectConfig };
