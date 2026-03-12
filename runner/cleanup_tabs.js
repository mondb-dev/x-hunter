#!/usr/bin/env node
/**
 * runner/cleanup_tabs.js — close all Chrome tabs except one x.com page
 *
 * Keeps exactly one x.com/home tab open. Closes everything else via CDP
 * HTTP API. Called after each agent run to prevent Chrome process accumulation.
 *
 * Exit 0 always (non-fatal — tab cleanup is best-effort).
 */
"use strict";

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:18801";
const TIMEOUT = 5_000;

(async () => {
  let tabs;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(`${CDP_URL}/json/list`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) process.exit(0);
    tabs = await res.json();
  } catch {
    process.exit(0); // CDP not available — skip silently
  }

  const pages = tabs.filter(t => t.type === "page");
  if (pages.length <= 1) process.exit(0);

  // Keep the first x.com page (or first page if none). Close the rest.
  const keep = pages.find(t => /x\.com|twitter\.com/.test(t.url)) || pages[0];
  const toClose = pages.filter(t => t.id !== keep.id);

  let closed = 0;
  for (const tab of toClose) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2_000);
      await fetch(`${CDP_URL}/json/close/${tab.id}`, { method: "GET", signal: ctrl.signal });
      clearTimeout(t);
      closed++;
    } catch { /* ignore individual close failures */ }
  }

  if (closed > 0) console.log(`[cleanup_tabs] closed ${closed} extra tab(s), kept: ${keep.url.slice(0, 60)}`);
  process.exit(0);
})();
