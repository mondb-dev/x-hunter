"use strict";
/**
 * HelmStackClient — zero-dependency HTTP client for the HelmStack browser
 * substrate agent API (http://127.0.0.1:7070 by default).
 *
 * Covers the surface social automation needs: tabs, navigation, JS evaluation,
 * text/key/mouse input (CDP-level, so it reaches cross-origin iframes), cookies,
 * and screenshots. Uses global fetch (Node 18+).
 */

class HelmStackClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]    Base URL (default env HELMSTACK_URL or http://127.0.0.1:7070)
   * @param {string} [opts.token]  Bearer token (default env HELMSTACK_AUTH_TOKEN)
   * @param {number} [opts.timeout] Default request timeout ms (default 30000)
   */
  constructor({ url, token, timeout } = {}) {
    this.url = (url || process.env.HELMSTACK_URL || "http://127.0.0.1:7070").replace(/\/$/, "");
    this.token = token || process.env.HELMSTACK_AUTH_TOKEN || "";
    this.defaultTimeout = timeout || 30000;
  }

  async request(method, path, body, { timeout } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || this.defaultTimeout);
    try {
      const res = await fetch(`${this.url}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const msg = data && data.error ? data.error : `HTTP ${res.status}`;
        throw new Error(`helmstack ${method} ${path}: ${msg}`);
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  // ── Core ──────────────────────────────────────────────────────────────────
  health()          { return this.request("GET", "/api/health", undefined, { timeout: 5000 }); }
  listTabs()        { return this.request("GET", "/api/tabs"); }
  openTab(url)      { return this.request("POST", "/api/tabs", { url }); }
  closeTab(id)      { return this.request("DELETE", `/api/tabs/${id}`); }
  navigate(id, url) { return this.request("POST", `/api/tabs/${id}/navigate`, { url }, { timeout: 90000 }); }
  getCookies(id)    { return this.request("GET", `/api/tabs/${id}/cookies`); }
  setCookie(id, c)  { return this.request("POST", `/api/tabs/${id}/cookies`, c); }
  screenshot(id)    { return this.request("GET", `/api/tabs/${id}/screenshot`); }

  // ── Input (CDP-level — reaches cross-origin iframes) ────────────────────────
  insertText(id, text) { return this.request("POST", `/api/tabs/${id}/insert-text`, { text }); }
  pressKey(id, opts)   { return this.request("POST", `/api/tabs/${id}/key`, opts); }
  clickAt(id, x, y)    { return this.request("POST", `/api/tabs/${id}/click`, { x, y }); }
  /** Cmd/Meta+Enter — submits many composers regardless of frame origin. */
  metaEnter(id)        { return this.pressKey(id, { key: "Enter", code: "Enter", keyCode: 13, modifiers: 4 }); }

  // ── Evaluation ──────────────────────────────────────────────────────────────
  /** Evaluate a raw JS expression in the page; returns the value. */
  async evaluate(id, expression, { timeout } = {}) {
    const out = await this.request("POST", `/api/tabs/${id}/evaluate`, { expression }, { timeout });
    return out ? out.value : null;
  }

  /** Evaluate a function with JSON-serialisable args (puppeteer-style). */
  evalFn(id, fn, ...args) {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
    return this.evaluate(id, expression);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  /** Current URL of a tab (from the tab list — reflects real navigation state). */
  async tabUrl(id) {
    const tabs = await this.listTabs();
    const tab = tabs.find((t) => t.id === id);
    return tab ? tab.url || "" : "";
  }

  /**
   * Find an existing tab whose URL matches `matcher` (RegExp/string), else open
   * one at `openUrl`. Returns the tab id.
   */
  async ensureTab(matcher, openUrl) {
    const re = matcher instanceof RegExp ? matcher : new RegExp(matcher);
    const tabs = await this.listTabs();
    const existing = tabs.find((t) => re.test(t.url || ""));
    if (existing) return existing.id;
    const before = new Set(tabs.map((t) => t.id));
    const after = await this.openTab(openUrl);
    const created = after.find((t) => !before.has(t.id));
    if (!created) throw new Error(`helmstack: could not open a tab for ${openUrl}`);
    return created.id;
  }

  /** Poll an in-page predicate function until truthy; throws after `attempts`. */
  async pollFn(id, label, fn, { attempts = 10, interval = 1000, tag = "helmstack" } = {}) {
    for (let i = 1; i <= attempts; i++) {
      const ok = await this.evalFn(id, fn).catch(() => false);
      if (ok) return;
      if (i < attempts) await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`${label} not ready after ${attempts} attempts`);
  }

  /** Wait for document.readyState === complete. */
  waitReady(id, opts = {}) {
    return this.pollFn(id, "document ready", () => document.readyState === "complete", {
      attempts: 30, interval: 1000, ...opts,
    });
  }

  // ── Approvals ───────────────────────────────────────────────────────────────
  approvals()             { return this.request("GET", "/api/approvals"); }
  approve(approvalId)     { return this.request("POST", `/api/approvals/${approvalId}/approve`, {}); }

  // ── Vault (optional; used for credential lookup/TOTP) ───────────────────────
  listAccounts()          { return this.request("GET", "/api/accounts"); }
  saveAccount(account)    { return this.request("POST", "/api/accounts", account); }
}

module.exports = { HelmStackClient };
