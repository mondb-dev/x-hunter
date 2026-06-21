#!/usr/bin/env node
/**
 * runner/inject_cookies.js — inject X.com session cookies into Chrome profile
 *
 * Usage:
 *   node inject_cookies.js /path/to/cookies.json
 *
 * cookies.json format (array of cookie objects):
 *   [{ "name": "auth_token", "value": "...", "domain": ".x.com" }, ...]
 *
 * Export from Chrome DevTools → Application → Cookies → right-click → export
 * Or use the EditThisCookie / Cookie-Editor extension JSON export format.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { connectBrowser } = require('./cdp');

const cookieFile = process.argv[2];
if (!cookieFile || !fs.existsSync(cookieFile)) {
  console.error('Usage: node inject_cookies.js /path/to/cookies.json');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));

// Normalise to puppeteer CookieParam format
const cookies = raw.map(c => ({
  name:     c.name,
  value:    c.value,
  domain:   c.domain   || '.x.com',
  path:     c.path     || '/',
  secure:   c.secure   !== undefined ? c.secure   : true,
  httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
  sameSite: c.sameSite || 'None',
  // Convert expiration date formats
  ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } :
      c.expires        ? { expires: Math.floor(c.expires) }       : {}),
}));

(async () => {
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`Cannot connect to Chrome: ${err.message}`);
    process.exit(1);
  }

  try {
    // Use CDP Session directly on the browser target to set cookies
    const pages = await browser.pages();
    const page  = pages.length ? pages[0] : await browser.newPage();

    // Navigate to x.com first so the cookie domain is valid
    await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 15000 })
      .catch(() => {}); // ignore detached frame

    await page.setCookie(...cookies);
    console.log(`Injected ${cookies.length} cookie(s) into Chrome`);

    // Reload to activate session
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const url = page.url();
    const loggedIn = !/login/.test(url);
    console.log(`Current URL: ${url}`);
    console.log(loggedIn ? 'X session ACTIVE — logged in' : 'Still on login page — cookies may be expired/wrong');
  } finally {
    browser.disconnect();
  }
})();
