"use strict";
/**
 * Session helpers — transplant a logged-in session into HelmStack by importing
 * cookies, and verify the result.
 *
 * Sourcing the cookies (from another browser profile, a CDP endpoint, an export
 * file, etc.) is left to the caller so this stays dependency-free. `cookies` is
 * an array of { name, value, domain, path?, httpOnly?, secure?, sameSite?, expires? }.
 * Note: HelmStack expects `expires` in **milliseconds**; puppeteer/CDP report
 * seconds, so multiply by 1000 before passing them in.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Import cookies into a HelmStack tab.
 * @returns {Promise<{imported:number, failed:number, total:number}>}
 */
async function importCookies(client, tabId, cookies) {
  let imported = 0, failed = 0;
  for (const c of cookies) {
    try {
      await client.setCookie(tabId, {
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      });
      imported++;
    } catch {
      failed++;
    }
  }
  return { imported, failed, total: cookies.length };
}

/**
 * Load a URL and run an in-page check function; returns its result.
 * `check` is a serialisable function evaluated in the page.
 */
async function verify(client, tabId, url, check) {
  await client.navigate(tabId, url);
  await client.waitReady(tabId, { tag: "session" });
  await sleep(4000);
  return client.evalFn(tabId, check);
}

module.exports = { importCookies, verify };
