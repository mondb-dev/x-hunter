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

  /** Trusted click on the first ON-SCREEN element matching `expr` (FB keeps
   *  offscreen dialog twins whose elements have negative coords — filter them). */
  async _trustedClick(expr) {
    const xy = await this.c.evaluate(this.tab, `(() => {
      const els = ${expr};
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.x >= 0 && r.y >= 0 && r.x < window.innerWidth) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    })()`).catch(() => null);
    if (!xy) return false;
    await this.c.request("POST", `/api/tabs/${this.tab}/click`, xy).catch(() => {});
    return true;
  }

  /**
   * Try to switch the open Create-post dialog's audience to Public. New FB
   * accounts have Public DISABLED ("Learn why this setting is disabled") —
   * in that case we keep the current audience and report why. The audience
   * picker's "Set as default audience" box is checked by default, so the
   * first successful Public selection also becomes the account default.
   * All clicks must be trusted CDP clicks (FB ignores synthetic .click()).
   * @returns {Promise<"public"|"disabled"|"unavailable">}
   */
  async _ensurePublicAudience() {
    const chip = await this._trustedClick(`[...document.querySelectorAll('[role="dialog"]')].filter(x => /create post/i.test(x.textContent || "")).flatMap(d => [...d.querySelectorAll('[role="button"]')]).filter(b => /^(friends|friends of friends|only me|close friends)$/i.test((b.textContent || "").trim()))`);
    if (!chip) {
      // Already Public, or no audience chip found.
      const already = await this.c.evalFn(this.tab, () => {
        const ds = [...document.querySelectorAll('[role="dialog"]')].filter((x) => /create post/i.test(x.textContent || ""));
        return ds.some((d) => [...d.querySelectorAll('[role="button"]')].some((b) => /^public$/i.test((b.textContent || "").trim())));
      }).catch(() => false);
      return already ? "public" : "unavailable";
    }
    await sleep(2500);

    const disabled = await this.c.evalFn(this.tab, () =>
      /learn why this setting is disabled/i.test(([...document.querySelectorAll('[role="dialog"]')].find((x) => /who can see your post/i.test(x.textContent || "")) || {}).textContent || "")
    ).catch(() => false);

    let outcome = "unavailable";
    if (!disabled) {
      const picked = await this._trustedClick(`[...document.querySelectorAll('[role="dialog"] [role="radio"], [role="dialog"] div[role="button"]')].filter(e => /^public/i.test((e.textContent || "").trim().slice(0, 10)))`);
      if (picked) { await sleep(1200); outcome = "public"; }
    } else {
      outcome = "disabled";
      this.log("Public audience is disabled on this account (new-account restriction) — keeping current audience");
    }
    // Done closes the audience view either way.
    await this._trustedClick(`[...document.querySelectorAll('[role="dialog"] [role="button"],[aria-label="Done"]')].filter(b => /^done$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim()))`);
    await sleep(1500);
    return outcome;
  }

  /**
   * Post a video with caption — FB's first posting capability (2026-07-20,
   * built for the daily stance-video cross-post). Drives the composer the
   * real-browser way: open the create-post dialog, attach via the dialog's
   * file input (CDP setFileInputFiles), type the caption, wait for FB's
   * upload/processing, click Post.
   *
   * FB's DOM is obfuscated; selectors lean on aria-labels and role attributes,
   * with generous polls. Any miss returns { posted:false, reason } — callers
   * treat FB as best-effort.
   * @returns {Promise<{posted:boolean, reason?:string, dryRun?:boolean}>}
   */
  async postVideo(text, videoPath, { dryRun = false } = {}) {
    if (!videoPath) return { posted: false, reason: "no_video" };
    await this.ensureTab();
    await this._goto(HOME_URL);
    await sleep(4000);

    // 0. Dismiss interstitials (e.g. the "You're in sleep mode" modal) — they
    // sit in [role=dialog] and hijack any dialog-scoped selector.
    await this.c.evalFn(this.tab, () => {
      const ok = [...document.querySelectorAll('[role="button"],button')]
        .find((b) => /^(ok|okay|not now|close)$/i.test((b.textContent || "").trim()));
      if (ok) ok.click();
      return !!ok;
    }).catch(() => false);
    await sleep(1500);

    // 1. Open the create-post dialog ("What's on your mind…").
    const opened = await this.c.evalFn(this.tab, () => {
      const trigger = [...document.querySelectorAll('[role="button"]')]
        .find((b) => /what'?s on your mind/i.test(b.textContent || ""));
      if (!trigger) return false;
      trigger.click(); return true;
    }).catch(() => false);
    if (!opened) return { posted: false, reason: "composer_trigger_not_found" };
    await sleep(3500);

    // 1b. Widest audience FB allows: Public when the account can, else keep
    // the default and log why. Never blocks the post.
    try {
      const audience = await this._ensurePublicAudience();
      this.log(`audience: ${audience}`);
    } catch (e) { this.log(`audience step failed (non-fatal): ${e.message}`); }

    // 2. The Create post dialog premounts its file input (verified live
    // 2026-07-20); the Photo/video click is only a fallback to force-mount it.
    const hasInput = await this.c.evalFn(this.tab, () => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => /create post/i.test(x.textContent || ""));
      if (!d) return false;
      if (!d.querySelector('input[type="file"]')) {
        const btn = [...d.querySelectorAll('[role="button"],[aria-label]')]
          .find((b) => /photo\/video|photo or video/i.test(b.getAttribute("aria-label") || b.textContent || ""));
        if (btn) btn.click();
      }
      return true;
    }).catch(() => false);
    if (!hasInput) return { posted: false, reason: "create_post_dialog_not_found" };
    await sleep(1500);

    // 3. Attach — scope to the dialog's input, global input as fallback.
    try { await this.c.setFileInput(this.tab, '[role="dialog"] input[type="file"]', [videoPath]); }
    catch { try { await this.c.setFileInput(this.tab, 'input[type="file"]', [videoPath]); }
    catch (e) { return { posted: false, reason: `file_input:${e.message}` }; } }

    // 4. Wait for the video to attach (thumbnail/player in the dialog).
    let attached = false;
    for (let i = 0; i < 30 && !attached; i++) {
      attached = await this.c.evalFn(this.tab, () => {
        const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => /create post/i.test(x.textContent || ""));
        return !!(d && (d.querySelector("video") || [...d.querySelectorAll("div")].some((e) => /uploading|processing/i.test(e.getAttribute("aria-label") || ""))));
      }).catch(() => false);
      if (!attached) await sleep(2000);
    }
    if (!attached) return { posted: false, reason: "video_not_attached" };

    // 5. Caption into the dialog's composer.
    if (text) {
      const focused = await this.c.evalFn(this.tab, () => {
        const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => /create post/i.test(x.textContent || ""));
        const box = d && d.querySelector('[contenteditable="true"][role="textbox"]');
        if (!box) return false;
        box.focus(); return true;
      }).catch(() => false);
      if (!focused) return { posted: false, reason: "caption_box_not_found" };
      try { await this.c.insertText(this.tab, text); } catch (e) { return { posted: false, reason: `caption:${e.message}` }; }
      await sleep(800);
    }

    // 6. Post (FB keeps it disabled until processing allows; poll on video timescales).
    let clicked = false;
    for (let i = 0; i < 16 && !clicked; i++) {
      if (dryRun) break;
      clicked = await this.c.evalFn(this.tab, () => {
        const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => /create post/i.test(x.textContent || ""));
        const btn = d && [...d.querySelectorAll('[role="button"],[aria-label="Post"]')]
          .find((b) => /^post$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim()) && b.getAttribute("aria-disabled") !== "true");
        if (!btn) return false;
        btn.click(); return true;
      }).catch(() => false);
      if (!clicked) await sleep(15000);
    }
    if (dryRun) { this.log("DRY RUN — video attached + caption set, not posting"); return { posted: false, reason: "dry_run", dryRun: true }; }
    if (!clicked) return { posted: false, reason: "post_button_not_enabled" };

    // FB uploads in the background after Post: success = the "being processed"
    // toast, or the Create post dialog going away. Poll up to ~2 min.
    for (let i = 0; i < 12; i++) {
      await sleep(10000);
      const done = await this.c.evalFn(this.tab, () => {
        const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => /create post/i.test(x.textContent || ""));
        const toast = [...document.querySelectorAll("div,span")].some((e) => /being processed|post is (now )?(ready|live)|shared to/i.test((e.textContent || "").slice(0, 80)));
        return !d || toast;
      }).catch(() => false);
      if (done) { this.log("video post submitted to Facebook"); return { posted: true }; }
    }
    return { posted: false, reason: "upload_unconfirmed" };
  }
}

module.exports = { FB, FB_HOME_URL: HOME_URL };
