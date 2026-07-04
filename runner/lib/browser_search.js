#!/usr/bin/env node
/**
 * runner/lib/browser_search.js — fully-local web search via the agent's own
 * headless Chrome (no Vertex/Gemini grounding, no API key).
 *
 * Reuses the CDP browser the runner already drives. Primary engine is Bing
 * (server-rendered, tolerant of headless scraping); DuckDuckGo's HTML endpoint
 * serves a bot CAPTCHA to headless Chrome, so it is only a last-ditch fallback.
 *
 * Exports:
 *   browserSearch(query, { maxResults=6 })
 *     → Promise<Array<{ title, url, snippet }>>
 */

'use strict';

const { connectBrowser } = require('../cdp');

function log(msg) { console.log(`[browser_search] ${msg}`); }

// Bing wraps result links as bing.com/ck/a?...&u=a1<base64url(real url)>&...
function decodeBingUrl(href) {
  try {
    const u = new URL(href);
    if (!/bing\.com$/.test(u.hostname) || !u.pathname.startsWith('/ck/a')) return href;
    let p = u.searchParams.get('u') || '';
    if (p.startsWith('a1')) p = p.slice(2);
    p = p.replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const dec = Buffer.from(p, 'base64').toString('utf8');
    return /^https?:/i.test(dec) ? dec : href;
  } catch { return href; }
}

// DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=<encoded real url>
function decodeDdgUrl(href) {
  if (!href) return '';
  try {
    if (href.startsWith('//')) href = 'https:' + href;
    const u = new URL(href);
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch { return href; }
}

async function scrapeBing(page, query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  const raw = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#b_results > li.b_algo')) {
      const a = el.querySelector('h2 a');
      const sn = el.querySelector('.b_caption p, .b_algoSlug, .b_lineclamp2, .b_lineclamp3');
      if (!a) continue;
      out.push({ title: (a.textContent || '').trim(), href: a.getAttribute('href') || '', snippet: (sn?.textContent || '').trim() });
    }
    return out;
  });
  return raw.map(r => ({ title: r.title, url: decodeBingUrl(r.href), snippet: r.snippet }));
}

async function scrapeDuckDuckGo(page, query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  const raw = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.result, .web-result')) {
      const a = el.querySelector('.result__a');
      const sn = el.querySelector('.result__snippet');
      if (!a) continue;
      out.push({ title: (a.textContent || '').trim(), href: a.getAttribute('href') || '', snippet: (sn?.textContent || '').trim() });
    }
    return out;
  });
  return raw.map(r => ({ title: r.title, url: decodeDdgUrl(r.href), snippet: r.snippet }));
}

/**
 * Run a web search in the agent's Chrome and return structured results.
 */
async function browserSearch(query, opts = {}) {
  const { maxResults = 6 } = opts;
  if (!query || typeof query !== 'string') return [];

  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    log(`browser connect failed: ${err.message}`);
    return [];
  }

  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');

    let results = [];
    try { results = await scrapeBing(page, query); } catch (e) { log(`bing failed: ${e.message}`); }
    if (!results || results.length === 0) {
      log('bing empty — trying DuckDuckGo');
      try { results = await scrapeDuckDuckGo(page, query); } catch (e) { log(`ddg failed: ${e.message}`); }
    }

    const seen = new Set();
    return (results || [])
      .filter(r => r.url && /^https?:/i.test(r.url) && !/bing\.com\/ck\//.test(r.url))
      .filter(r => { const k = r.url.split('#')[0]; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, maxResults);
  } finally {
    if (page) await page.close().catch(() => {});
    // do not disconnect — the browser is shared with the runner
  }
}

module.exports = { browserSearch };
