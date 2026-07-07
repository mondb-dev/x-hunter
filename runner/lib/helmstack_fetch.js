'use strict';
/**
 * runner/lib/helmstack_fetch.js — directed page fetch via HelmStack.
 *
 * Opens a DEDICATED tab (not the X/LinkedIn/FB browse tabs), navigates to a URL,
 * extracts the readable main text, and closes the tab. This is the "directed
 * reading" capability that replaces the retired CDP fetch: the browse cycle can
 * now actually READ a queued lead's content, not just be told the URL exists.
 *
 * Uses the logged-in HelmStack session, so it can read X/LinkedIn/FB pages too.
 * Never throws — returns cleaned text (capped) or null on any failure.
 */

const { HelmStackClient } = require('../../tools/helmstack-social/src');

async function fetchPageText(url, { maxChars = 4000, settleMs = 2500 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const c = new HelmStackClient();
  let tabId = null;
  try {
    await c.health();
    // Open a fresh, dedicated tab (diff the tab list to find it) so we don't
    // hijack the browse/social tabs — mirrors client.ensureTab's open path.
    const before = new Set((await c.listTabs()).map((t) => t.id));
    const after = await c.openTab(url);
    const created = (after || []).find((t) => !before.has(t.id));
    tabId = created && created.id;
    if (!tabId) return null;

    await c.waitReady(tabId, { tag: 'fetch', attempts: 12 }).catch(() => {});
    await new Promise((r) => setTimeout(r, settleMs));

    const text = await c.evalFn(tabId, (mc) => {
      const root = document.querySelector('article, main, [role=main]') || document.body;
      if (!root) return '';
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,nav,aside,footer,header,form,svg,button').forEach((e) => e.remove());
      return (clone.innerText || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, mc);
    }, maxChars);

    return text && text.trim().length > 80 ? text.trim() : null;
  } catch {
    return null;
  } finally {
    if (tabId) { try { await c.closeTab(tabId); } catch { /* ignore */ } }
  }
}

/**
 * Web search via HelmStack (DuckDuckGo HTML endpoint), returning real result
 * URLs (DDG wraps them in /l/?uddg=<encoded> redirects — decoded here) so a
 * caller can then fetchPageText() the promising ones. Never throws.
 * @returns {Promise<Array<{title:string, url:string, snippet:string}>>}
 */
async function searchWeb(query, { max = 6, settleMs = 1800 } = {}) {
  if (!query) return [];
  const c = new HelmStackClient();
  let tabId = null;
  try {
    await c.health();
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const before = new Set((await c.listTabs()).map((t) => t.id));
    const after = await c.openTab(url);
    const created = (after || []).find((t) => !before.has(t.id));
    tabId = created && created.id;
    if (!tabId) return [];
    await c.waitReady(tabId, { tag: 'search', attempts: 12 }).catch(() => {});
    await new Promise((r) => setTimeout(r, settleMs));
    const results = await c.evalFn(tabId, (mx) => {
      const decode = (href) => {
        try {
          const m = /[?&]uddg=([^&]+)/.exec(href || '');
          return m ? decodeURIComponent(m[1]) : href;
        } catch { return href; }
      };
      return [].slice.call(document.querySelectorAll('.result__body, .web-result')).slice(0, mx).map((r) => {
        const a = r.querySelector('.result__a, a.result__url, .result__title a');
        const s = r.querySelector('.result__snippet');
        return { title: (a ? a.innerText : '').trim(), url: decode(a ? a.getAttribute('href') : ''), snippet: (s ? s.innerText : '').trim() };
      }).filter((x) => x.title && /^https?:\/\//.test(x.url));
    }, max);
    return results || [];
  } catch {
    return [];
  } finally {
    if (tabId) { try { await c.closeTab(tabId); } catch { /* ignore */ } }
  }
}

module.exports = { fetchPageText, searchWeb };
