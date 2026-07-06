"use strict";
/**
 * helmstack-social/src/fb.js — Facebook engine (parallel to x.js / linkedin.js).
 *
 * Facebook is the most automation-hostile of the three surfaces (obfuscated
 * classes, isTrusted checks on buttons), so:
 *   - post text is read from role=article containers (first substantial dir=auto
 *     block by DOM order — the post body renders above comments);
 *   - actions (follow/Like a page) use HelmStack's /click (a TRUSTED CDP mouse
 *     event) because FB ignores synthetic .click() on its buttons.
 *
 * Scope today: sessionOk, scrapePage (public Page timeline → posts) and
 * followPage (Like/Follow a Page). No posting — FB is observation-first.
 */

const HOME_URL = "https://www.facebook.com/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FB {
  constructor(client, { ownName = "Sebastian Hunter", log } = {}) {
    this.c = client;
    this.ownName = ownName;
    this.log = log || (() => {});
    this.tab = null;
  }

  async ensureTab() {
    this.tab = await this.c.ensureTab(/https:\/\/(www\.)?facebook\.com/, HOME_URL);
    await this.c.waitReady(this.tab, { tag: "fb", attempts: 15 }).catch(() => {});
    return this.tab;
  }

  /** Logged in ⇔ no login form present. */
  async sessionOk() {
    try {
      const onLogin = await this.c.evalFn(this.tab, () => !!document.querySelector('input[name=pass], #pass'));
      return !onLogin;
    } catch { return false; }
  }

  async _goto(url) {
    await this.c.navigate(this.tab, url).catch(() => {});
    await sleep(1500);
    await this.c.waitReady(this.tab, { tag: "fb" }).catch(() => {});
  }

  /**
   * Scrape a public Page's recent posts.
   * @param {string} pageUrl  e.g. https://www.facebook.com/rappler
   * @returns {Promise<Array<{permalink:string, text:string}>>}
   */
  async scrapePage(pageUrl, { limit = 8, scrolls = 3 } = {}) {
    await this._goto(pageUrl);
    await sleep(3000);
    for (let i = 0; i < scrolls; i++) {
      await this.c.evalFn(this.tab, () => window.scrollBy(0, window.innerHeight * 1.4)).catch(() => {});
      await sleep(1800);
    }
    const posts = await this.c.evalFn(this.tab, (lim) => {
      // Top-level post articles only — FB nests comment articles inside posts.
      const arts = [...document.querySelectorAll("div[role=article]")]
        .filter((a) => !a.parentElement || !a.parentElement.closest("div[role=article]"));
      const out = [], seen = new Set();
      for (const a of arts) {
        const links = [...a.querySelectorAll("a[href]")].map((x) => x.getAttribute("href") || "");
        let perma = (links.find((h) => /\/posts\/|\/permalink\/|story_fbid=|\/videos\//.test(h)) || "").split("?")[0];
        if (!perma) continue;
        if (!/^https?:/.test(perma)) perma = "https://www.facebook.com" + perma;
        if (seen.has(perma)) continue;
        seen.add(perma);
        // Caption: on a Page timeline comments are collapsed, so the longest
        // dir=auto block in the post article is the caption. Try FB's message
        // container first when present.
        const sm = a.querySelector("[data-ad-rendering-role=story_message], [data-ad-comet-preview=message], [data-ad-preview=message]");
        let text = sm ? (sm.innerText || "").trim() : "";
        if (text.length < 20) {
          const blocks = [...a.querySelectorAll("div[dir=auto]")].map((d) => (d.innerText || "").trim());
          const longest = blocks.sort((x, y) => y.length - x.length)[0] || "";
          if (longest.length > text.length) text = longest;
        }
        text = text.replace(/\s+/g, " ");
        out.push({ permalink: perma, text: text.slice(0, 600) });
        if (out.length >= lim) break;
      }
      return out;
    }, limit);
    return posts || [];
  }

  /**
   * Follow/Like a Page (a trusted CDP click — FB ignores synthetic clicks).
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async followPage(pageUrl, { dryRun = false } = {}) {
    await this._goto(pageUrl);
    await sleep(3000);
    const coords = await this.c.evalFn(this.tab, () => {
      // Prefer an explicit Follow; else Like (Liking a Page follows it).
      const btns = [...document.querySelectorAll('[role=button],[aria-label]')];
      const b = btns.find((x) => /^follow$/i.test((x.getAttribute("aria-label") || "").trim())) ||
                btns.find((x) => /^like$/i.test((x.getAttribute("aria-label") || "").trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!coords) return { ok: false, reason: "no_follow_button_or_already" };
    if (dryRun) { this.log(`DRY RUN — follow button located on ${pageUrl}`); return { ok: false, reason: "dry_run", dryRun: true }; }
    await this.c.request("POST", `/api/tabs/${this.tab}/click`, coords).catch((e) => this.log(`click err: ${e.message}`));
    await sleep(2500);
    return { ok: true };
  }
}

module.exports = { FB, FB_HOME_URL: HOME_URL };
