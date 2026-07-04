"use strict";
/**
 * runner/lib/helmstack.js — thin HTTP client for the HelmStack browser substrate
 *
 * HelmStack exposes an HTTP+SSE agent API on 127.0.0.1:7070 (localhost only).
 * This client covers the subset hunter needs for posting: tabs, navigation,
 * JS evaluation, cookies, screenshots, and approvals. Zero dependencies —
 * uses global fetch (Node 18+).
 *
 * Env:
 *   HELMSTACK_URL         base URL (default http://127.0.0.1:7070)
 *   HELMSTACK_AUTH_TOKEN  bearer token (required — the daemon rejects without it)
 */

const HELMSTACK_URL = (process.env.HELMSTACK_URL || "http://127.0.0.1:7070").replace(/\/$/, "");
const AUTH_TOKEN    = process.env.HELMSTACK_AUTH_TOKEN || "";

async function request(method, apiPath, body, { timeout = 30_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${HELMSTACK_URL}${apiPath}`, {
      method,
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${AUTH_TOKEN}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
      throw new Error(`helmstack ${method} ${apiPath}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function health()            { return request("GET", "/api/health", undefined, { timeout: 5_000 }); }
function listTabs()          { return request("GET", "/api/tabs"); }
function openTab(url)        { return request("POST", "/api/tabs", { url }); }
function navigate(id, url)   { return request("POST", `/api/tabs/${id}/navigate`, { url }, { timeout: 90_000 }); }
function getCookies(id)      { return request("GET", `/api/tabs/${id}/cookies`); }
function setCookie(id, c)    { return request("POST", `/api/tabs/${id}/cookies`, c); }
function screenshot(id)      { return request("GET", `/api/tabs/${id}/screenshot`); }
function insertText(id, text){ return request("POST", `/api/tabs/${id}/insert-text`, { text }); }
function pressKey(id, opts)  { return request("POST", `/api/tabs/${id}/key`, opts); }
/** Cmd/Meta+Enter — submits LinkedIn/X composers regardless of frame origin. */
function metaEnter(id)       { return pressKey(id, { key: "Enter", code: "Enter", keyCode: 13, modifiers: 4 }); }
/** Real left mouse click at viewport CSS coords (reaches cross-origin iframes). */
function clickAt(id, x, y)   { return request("POST", `/api/tabs/${id}/click`, { x, y }); }
function approvals()         { return request("GET", "/api/approvals"); }
function approve(approvalId) { return request("POST", `/api/approvals/${approvalId}/approve`, {}); }

/** Evaluate a raw JS expression in the tab. Returns the value (JSON-serialisable). */
async function evaluate(id, expression, { timeout = 30_000 } = {}) {
  const out = await request("POST", `/api/tabs/${id}/evaluate`, { expression }, { timeout });
  return out ? out.value : null;
}

/**
 * Evaluate a function with JSON-serialisable args in the tab.
 * Mirrors puppeteer's page.evaluate(fn, ...args) calling convention so the
 * legacy in-page snippets port over unchanged.
 */
function evalFn(id, fn, ...args) {
  const expression = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(",")})`;
  return evaluate(id, expression);
}

/** Find an existing x.com/twitter.com tab, or open one on x.com/home. Returns tab id. */
async function ensureXTab() {
  const tabs = await listTabs();
  const existing = tabs.find(t => /https:\/\/(x|twitter)\.com/.test(t.url || ""));
  if (existing) return existing.id;
  const before = new Set(tabs.map(t => t.id));
  const after = await openTab("https://x.com/home");
  const created = after.find(t => !before.has(t.id));
  if (!created) throw new Error("helmstack: could not open x.com tab");
  return created.id;
}

/** Current URL of a tab (from the tab list — reflects real navigation state). */
async function tabUrl(id) {
  const tabs = await listTabs();
  const tab = tabs.find(t => t.id === id);
  return tab ? (tab.url || "") : "";
}

/** Poll an in-page predicate function until truthy. Throws after `attempts`. */
async function pollFn(id, label, fn, { attempts = 10, interval = 1_000, tag = "helmstack" } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const ok = await evalFn(id, fn).catch(() => false);
    if (ok) {
      console.log(`[${tag}] ${label} ready (attempt ${i}/${attempts})`);
      return;
    }
    if (i < attempts) await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`${label} not found after ${attempts} attempts`);
}

/** Wait for document.readyState === complete (after navigate). */
function waitReady(id, opts = {}) {
  return pollFn(id, "document ready", () => document.readyState === "complete",
    { attempts: 30, interval: 1_000, ...opts });
}

module.exports = {
  HELMSTACK_URL,
  request, health,
  listTabs, openTab, navigate, tabUrl, ensureXTab,
  evaluate, evalFn, pollFn, waitReady,
  getCookies, setCookie, screenshot, insertText, pressKey, metaEnter, clickAt,
  approvals, approve,
};
