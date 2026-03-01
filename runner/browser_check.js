#!/usr/bin/env node
/**
 * runner/browser_check.js — browser health check via CDP HTTP endpoint
 *
 * Fetches /json/version from Chrome's CDP port. This is a direct HTTP call
 * that doesn't depend on playwright-core version compatibility.
 *
 * Exit 0 = healthy (Chrome responding on CDP port)
 * Exit 1 = not healthy
 *
 * Usage: node runner/browser_check.js
 * Timeout: 5s
 */

"use strict";

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:18801";
const TIMEOUT_MS = 5_000;

const controller = new AbortController();
const timer = setTimeout(() => {
  controller.abort();
  console.error("[browser_check] timeout after 5s");
  process.exit(1);
}, TIMEOUT_MS);

fetch(`${CDP_URL}/json/version`, { signal: controller.signal })
  .then(res => {
    clearTimeout(timer);
    if (res.ok) {
      process.exit(0);
    } else {
      console.error(`[browser_check] CDP returned HTTP ${res.status}`);
      process.exit(1);
    }
  })
  .catch(e => {
    clearTimeout(timer);
    console.error("[browser_check] failed:", e.message);
    process.exit(1);
  });
