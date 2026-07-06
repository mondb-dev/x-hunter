"use strict";
/**
 * X (Twitter) — activity engine over a HelmStack browser session.
 *
 * Same shape as the LinkedIn engine: the class knows *how* to drive X (browse,
 * post, quote, like, reply); *what* to post, *which* posts matter, and *how* to
 * log are injected into engage() as hooks. Zero coupling to any host app.
 *
 * Mechanism note: unlike LinkedIn (whose composer is isolated in cross-origin
 * iframes, forcing an API path), X's composer and feed are all top-frame with
 * stable data-testid selectors, so UI automation via CDP input is the reliable
 * path here. Text is inserted with HelmStack's insert-text endpoint (CDP
 * Input.insertText → the React composer state tracks it); posts are confirmed by
 * scanning the author's profile for the new status URL.
 */

const HOME_URL = "https://x.com/home";
const COMPOSE_BOX = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

class X {
  /**
   * @param {import('./client').HelmStackClient} client
   * @param {object} [opts]
   * @param {string} [opts.ownHandle] The account's own handle (no @), used to
   *   confirm posts from the profile and skip own posts. Default "SebastianHunts".
   * @param {boolean} [opts.dedicatedTab] Open a private tab instead of adopting
   *   an existing x.com tab. REQUIRED for flows that navigate away from home or
   *   hold a composer open (reply, follow) — concurrent consumers (collect.js
   *   ticks every 10 min) adopt and navigate the shared tab mid-flow otherwise.
   *   Call close() when done.
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor(client, { ownHandle = "SebastianHunts", dedicatedTab = false, log } = {}) {
    this.c = client;
    this.handle = ownHandle;
    this.dedicated = dedicatedTab;
    this.log = log || ((m) => console.log(`[x] ${m}`));
    this.tab = null;
  }

  async _eval(body, timeout = 20000) {
    return this.c.evaluate(this.tab, `(function(){${body}\n})()`, { timeout });
  }

  // ── Session / tab ───────────────────────────────────────────────────────────
  async ensureTab() {
    if (this.dedicated) {
      if (!this.tab) {
        const before = new Set((await this.c.listTabs()).map((t) => t.id));
        const after = await this.c.openTab(HOME_URL);
        const created = (after || []).find((t) => !before.has(t.id));
        if (!created) throw new Error("could not open dedicated X tab");
        this.tab = created.id;
      }
    } else {
      this.tab = await this.c.ensureTab(/https:\/\/(www\.)?(x|twitter)\.com/, HOME_URL);
    }
    // A freshly-opened tab may not have its session cookies readable yet; wait
    // for it to settle so sessionOk() doesn't get a false negative.
    await this.c.waitReady(this.tab, { tag: "x", attempts: 15 }).catch(() => {});
    return this.tab;
  }

  /** Close the engine's tab (dedicated-tab flows should call this when done). */
  async close() {
    if (this.tab) {
      await this.c.closeTab(this.tab).catch(() => {});
      this.tab = null;
    }
  }

  async sessionOk({ attempts = 3 } = {}) {
    // A freshly-opened (esp. dedicated) tab can race the cookie read — retry
    // before declaring the session absent, or consumers spuriously exit.
    for (let i = 0; i < attempts; i++) {
      try {
        const cookies = await this.c.getCookies(this.tab);
        const names = cookies.map((k) => k.name);
        if (names.includes("auth_token") && names.includes("ct0")) return true;
      } catch {}
      if (i < attempts - 1) await sleep(2000);
    }
    return false;
  }

  async gotoHome() {
    await this.c.navigate(this.tab, HOME_URL);
    await this.c.waitReady(this.tab, { tag: "x" });
    await sleep(2500);
  }

  /** Close the current tab and open a fresh one at `url` (reuses an exact-URL match). */
  async _freshTab(url) {
    await this.c.closeTab(this.tab).catch(() => {});
    const esc = url.replace(/[?#].*$/, "").toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.tab = await this.c.ensureTab(new RegExp(`^${esc}`, "i"), url);
  }

  /**
   * Navigate to `url` and verify the tab actually lands there. A long-lived X
   * tab can wedge — navigations error and snap back to /home (and CDP input
   * stops registering) while a fresh tab in the same session works fine — so
   * on a landing mismatch OR an error-status tab it is closed and reopened at
   * `url`. Returns false if even the fresh tab doesn't land.
   */
  async _gotoChecked(url) {
    const target = url.replace(/[?#].*$/, "").toLowerCase();
    const landed = async () => {
      await this.c.waitReady(this.tab, { tag: "x", attempts: 15 }).catch(() => {});
      await sleep(1500);
      const tabs = await this.c.listTabs().catch(() => []);
      const t = tabs.find((tb) => tb.id === this.tab);
      // An error-status tab has demonstrated a failed load — treat as wedged
      // even if the URL matches (its CDP input is typically dead too).
      if (!t || t.status === "error") return false;
      return (t.url || "").replace(/[?#].*$/, "").toLowerCase() === target;
    };
    await this.c.navigate(this.tab, url).catch(() => {});
    if (await landed()) return true;
    this.log(`nav to ${url} did not land — recycling wedged tab`);
    await this._freshTab(url);
    return landed();
  }

  // ── Composer helpers (top-frame) ────────────────────────────────────────────
  /**
   * Focus the composer with a real browser-level click. element.focus() alone
   * does not reliably move CDP input focus in a freshly-opened reply modal —
   * the first Input.insertText after it lands nowhere.
   */
  async _focusComposer() {
    const raw = await this.c.evalFn(this.tab, (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      e.scrollIntoView({ block: "center" });
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return JSON.stringify({ x: Math.round(r.x + Math.min(r.width / 2, 200)), y: Math.round(r.y + Math.min(r.height / 2, 20)) });
    }, COMPOSE_BOX).catch(() => null);
    let pt = null;
    try { pt = JSON.parse(raw); } catch {}
    if (pt) await this.c.clickAt(this.tab, pt.x, pt.y).catch(() => {});
    await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) { e.click(); e.focus(); } }, COMPOSE_BOX);
  }

  /**
   * Empty the composer, verifying it actually emptied. execCommand
   * selectAll/delete stops working once the composer contains a linkified
   * URL — fall back to a browser-level Cmd+A + Backspace.
   */
  async _clearComposer() {
    const isEmpty = () => this.c.evalFn(this.tab, (sel) => {
      const e = document.querySelector(sel);
      return !e || e.innerText.trim().length === 0;
    }, COMPOSE_BOX);
    for (let t = 0; t < 3; t++) {
      await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) { e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } }, COMPOSE_BOX);
      await sleep(400);
      if (await isEmpty()) return true;
      await this._focusComposer();
      await this.c.pressKey(this.tab, { key: "a", code: "KeyA", keyCode: 65, modifiers: 4 }).catch(() => {});
      await sleep(200);
      await this.c.pressKey(this.tab, { key: "Backspace", code: "Backspace", keyCode: 8 }).catch(() => {});
      await sleep(400);
      if (await isEmpty()) return true;
    }
    return isEmpty();
  }

  /**
   * Insert text into the (already-open) composer and verify it matches.
   * Input.insertText quirks (all empirically observed against X's composer):
   * - a payload containing "scheme://" is dropped ENTIRELY — URLs must be
   *   inserted in pieces split at the scheme boundary;
   * - a payload containing "\n" is dropped ENTIRELY — lines are inserted
   *   separately with a real Enter keypress between them;
   * - the first insert into a fresh modal/block can be silently buffered,
   *   flushing (doubled) with the next call — per-line verify + full-text
   *   verify + clear-and-retry converge on the exact text.
   */
  async _insertVerified(text) {
    await this._focusComposer();
    await humanDelay(1500, 3000);
    // Warm up the input channel: the first insertText into a fresh modal is
    // silently buffered (it flushes, doubled, with a later call). Poke with a
    // probe char until something visibly registers, then clear it.
    for (let t = 0; t < 4; t++) {
      await this.c.insertText(this.tab, ".").catch(() => {});
      await sleep(400);
      const seen = await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); return e ? e.innerText.trim().length > 0 : false; }, COMPOSE_BOX);
      if (seen) break;
    }
    await this._clearComposer();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this._focusComposer();
      await sleep(300);
      try {
        const lines = text.split("\n");
        let ok = true;
        for (let li = 0; li < lines.length && ok; li++) {
          if (lines[li]) {
            // Split at URL scheme boundaries, keeping the preceding space with
            // the scheme (a trailing space before a URL gets swallowed):
            // "see https://a/b" → ["see", " https:", "//a/b"]
            const pieces = lines[li].split(/(\s?https?:)(?=\/\/)/).filter(Boolean);
            for (const piece of pieces) {
              await this.c.insertText(this.tab, piece);
              await sleep(300);
              // The LAST character of each insert is held in a buffer that only
              // flushes on the next input event — send a harmless End keypress
              // so it flushes in place instead of after later text.
              await this.c.pressKey(this.tab, { key: "End", code: "End", keyCode: 35 }).catch(() => {});
              await sleep(300);
            }
            // insertText commits asynchronously — poll until the FULL line is
            // visible before pressing Enter, or the keypress jumps the commit
            // queue and stray tail characters flush after the next line.
            ok = false;
            for (let t = 0; t < 6 && !ok; t++) {
              const sofar = await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); return e ? e.innerText : ""; }, COMPOSE_BOX);
              ok = norm(sofar).endsWith(norm(lines[li]));
              if (!ok) await sleep(500);
            }
            if (!ok) break; // line didn't fully commit — bail with composer intact
          }
          // Only reached with the line's text verified present — so focus is
          // proven to be in the composer and Enter can't activate a button.
          if (li < lines.length - 1) await this.c.pressKey(this.tab, { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
        }
      } catch {
        await this.c.evalFn(this.tab, (t, sel) => { const e = document.querySelector(sel); if (e) { e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); document.execCommand("insertText", false, t); } }, text, COMPOSE_BOX);
      }
      await sleep(1500);
      const got = await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); return e ? e.innerText : ""; }, COMPOSE_BOX);
      if (norm(got) === norm(text)) return true;
      this.log(`text verify miss ${attempt}/3 (${(got || "").trim().length}/${text.length})`);
      await this._clearComposer();
    }
    return false;
  }

  /** Detect an anti-automation ("automated/spam") toast. */
  _toast() {
    return this.c.evalFn(this.tab, () => {
      const ts = Array.from(document.querySelectorAll('[data-testid="toast"], [role="alert"]'));
      return ts.map((t) => t.innerText).find((t) => /automated|spam/i.test(t)) || null;
    }).catch(() => null);
  }

  /** Wait for the Post button to become enabled. */
  _waitPostEnabled() {
    return this.c.pollFn(this.tab, "post button enabled", () => {
      const el = document.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]');
      return el != null && el.getAttribute("aria-disabled") !== "true";
    }, { attempts: 15, interval: 1000, tag: "x" });
  }

  _clickPost() {
    return this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) e.click(); return !!e; }, POST_BUTTON);
  }

  /** Scan the author's profile for a status URL matching `text`; returns URL or null. */
  async _confirmFromProfile(text, attempts = 5, delayMs = 4000) {
    const needle = norm(text).toLowerCase().slice(0, 50);
    await this._gotoChecked(`https://x.com/${this.handle}`);
    await sleep(3000);
    for (let i = 1; i <= attempts; i++) {
      await sleep(delayMs);
      const url = await this.c.evalFn(this.tab, (n, handle) => {
        const nz = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
        const arts = Array.from(document.querySelectorAll("article")).slice(0, 15);
        for (const a of arts) {
          if (!nz(a.innerText).includes(n)) continue;
          const links = Array.from(a.querySelectorAll('a[href*="/status/"]')).map((x) => x.getAttribute("href") || "");
          const href = links.find((h) => new RegExp(`/${handle}/status/\\d+`, "i").test(h) && !/\/analytics/i.test(h));
          if (href) return `https://x.com${href.split("?")[0]}`;
        }
        return null;
      }, needle, this.handle).catch(() => null);
      if (url && /\/status\/\d+/.test(url)) return url;
      if (i % 2 === 0) { await this.c.evaluate(this.tab, "location.reload()").catch(() => {}); await this.c.waitReady(this.tab, { tag: "x" }).catch(() => {}); await sleep(2000); }
    }
    return null;
  }

  // ── Posting ─────────────────────────────────────────────────────────────────
  /**
   * Publish a tweet.
   * @returns {Promise<{posted:boolean, url?:string|null, reason?:string, dryRun?:boolean}>}
   */
  async post(text, { dryRun = false } = {}) {
    await this.gotoHome();
    await humanDelay(2000, 4000);
    try {
      await this.c.pollFn(this.tab, "compose box", () => !!document.querySelector('[data-testid="tweetTextarea_0"]'), { attempts: 15, interval: 1000, tag: "x" });
    } catch {
      return { posted: false, reason: "compose_box_not_found" };
    }
    if (!(await this._insertVerified(text))) return { posted: false, reason: "text_insert_failed" };
    try { await this._waitPostEnabled(); } catch { return { posted: false, reason: "post_button_disabled" }; }
    const pre = await this._toast();
    if (pre) return { posted: false, reason: `anti_automation:${pre}` };

    if (dryRun) {
      this.log(`DRY RUN — composer verified, not posting`);
      await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) { e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } }, COMPOSE_BOX);
      return { posted: false, reason: "dry_run", dryRun: true };
    }

    await humanDelay(1500, 3000);
    await this._clickPost();
    await sleep(5000);
    const post2 = await this._toast();
    if (post2) return { posted: false, reason: `anti_automation:${post2}` };

    const url = await this._confirmFromProfile(text);
    if (url) { this.log(`posted: ${url}`); return { posted: true, url }; }
    // Landed back on home with no toast → probable success, URL uncaptured
    const now = await this.c.tabUrl(this.tab).catch(() => "");
    if (/\/home/.test(now)) { this.log("probable success (URL not captured)"); return { posted: true, url: null }; }
    return { posted: false, reason: "post_unconfirmed" };
  }

  /**
   * Quote-tweet a source post with commentary.
   * @param {string} sourceUrl  https://x.com/<user>/status/<id>
   */
  async quote(sourceUrl, text, { dryRun = false, skipIfMentions = [] } = {}) {
    await this.c.navigate(this.tab, sourceUrl);
    await this.c.waitReady(this.tab, { tag: "x" });
    await humanDelay(2000, 4000);
    try {
      await this.c.pollFn(this.tab, "retweet button", () => !!document.querySelector("[data-testid='retweet']"), { attempts: 15, interval: 1000, tag: "x" });
    } catch {
      return { posted: false, reason: "retweet_button_not_found" };
    }
    // Optional policy guard: never quote a tweet that mentions the given handles.
    if (skipIfMentions.length) {
      const mentions = await this.c.evalFn(this.tab, (handles) => {
        const t = (document.querySelector('[data-testid="tweetText"]')?.innerText || "").toLowerCase();
        const links = Array.from(document.querySelectorAll('[data-testid="tweet"] a[href^="/"]')).map((a) => (a.getAttribute("href") || "").toLowerCase()).join(" ");
        const full = t + " " + links;
        return handles.some((h) => full.includes(h.toLowerCase()) || full.includes("@" + h.toLowerCase()));
      }, skipIfMentions).catch(() => false);
      if (mentions) return { posted: false, reason: "skipped_mentions_self" };
    }
    await this.c.evalFn(this.tab, () => { document.querySelector("[data-testid='retweet']")?.click(); });
    try {
      await this.c.pollFn(this.tab, "quote menu item", () => Array.from(document.querySelectorAll("[role='menuitem']")).some((i) => (i.innerText || "").trim().toLowerCase() === "quote"), { attempts: 8, interval: 1000, tag: "x" });
    } catch {
      return { posted: false, reason: "quote_menu_not_found" };
    }
    await this.c.evalFn(this.tab, () => { const q = Array.from(document.querySelectorAll("[role='menuitem']")).find((i) => (i.innerText || "").trim().toLowerCase() === "quote"); if (q) q.click(); });
    try {
      await this.c.pollFn(this.tab, "compose box", () => !!document.querySelector('[data-testid="tweetTextarea_0"]'), { attempts: 10, interval: 1000, tag: "x" });
    } catch {
      return { posted: false, reason: "compose_box_not_found" };
    }
    if (!(await this._insertVerified(text))) return { posted: false, reason: "text_insert_failed" };
    try { await this._waitPostEnabled(); } catch { return { posted: false, reason: "post_button_disabled" }; }
    const pre = await this._toast();
    if (pre) return { posted: false, reason: `anti_automation:${pre}` };

    if (dryRun) {
      this.log(`DRY RUN — quote composer verified, not posting`);
      await this.c.navigate(this.tab, HOME_URL).catch(() => {});
      return { posted: false, reason: "dry_run", dryRun: true };
    }

    await humanDelay(1500, 3000);
    await this._clickPost();
    await sleep(5000);
    const url = await this._confirmFromProfile(text);
    if (url) { this.log(`quoted: ${url}`); return { posted: true, url }; }
    return { posted: false, reason: "post_unconfirmed" };
  }

  /**
   * Reply to a tweet. If the compose/insert sequence fails (a wedged tab kills
   * CDP input even when the URL check passes — e.g. after idling through slow
   * LLM work), the tab is recycled and the sequence retried once.
   * @param {string} tweetUrl  the target status URL
   */
  async reply(tweetUrl, text, { dryRun = false } = {}) {
    if (!(await this._gotoChecked(tweetUrl))) return { ok: false, reason: "navigation_failed" };
    let res = await this._replyOnPage(tweetUrl, text, { dryRun });
    const retryable = ["reply_button_not_found", "compose_box_not_found", "text_insert_failed"];
    if (!res.ok && !res.dryRun && retryable.includes(res.reason)) {
      this.log(`reply attempt failed (${res.reason}) — recycling tab and retrying once`);
      await this._freshTab(tweetUrl);
      if (!(await this._gotoChecked(tweetUrl))) return { ok: false, reason: "navigation_failed" };
      res = await this._replyOnPage(tweetUrl, text, { dryRun });
    }
    return res;
  }

  /** One compose-and-post attempt on the already-loaded permalink page. */
  async _replyOnPage(tweetUrl, text, { dryRun = false } = {}) {
    await sleep(3000);
    // Click the reply affordance on the tweet matching the target status id.
    // On a reply's permalink X renders ancestor tweets ABOVE the focused one,
    // so "first article" would thread the reply onto the wrong tweet.
    const targetId = (tweetUrl.match(/\/status\/(\d+)/) || [])[1] || "";
    const clicked = await this.c.evalFn(this.tab, (id) => {
      const arts = Array.from(document.querySelectorAll("article"));
      const target = (id && arts.find((a) => a.querySelector(`a[href*="/status/${id}"]`))) || arts[0];
      const b = target && target.querySelector('[data-testid="reply"]');
      if (b) { b.click(); return true; }
      return false;
    }, targetId);
    if (!clicked) return { ok: false, reason: "reply_button_not_found" };
    await sleep(2000);
    try {
      await this.c.pollFn(this.tab, "compose box", () => !!document.querySelector('[data-testid="tweetTextarea_0"]'), { attempts: 10, interval: 1000, tag: "x" });
    } catch {
      return { ok: false, reason: "compose_box_not_found" };
    }
    if (!(await this._insertVerified(text))) return { ok: false, reason: "text_insert_failed" };
    try { await this._waitPostEnabled(); } catch { return { ok: false, reason: "post_button_disabled" }; }
    const pre = await this._toast();
    if (pre) return { ok: false, reason: `anti_automation:${pre}` };

    if (dryRun) {
      this.log(`DRY RUN — reply composer verified, not posting`);
      await this.c.navigate(this.tab, HOME_URL).catch(() => {});
      return { ok: false, reason: "dry_run", dryRun: true };
    }

    await humanDelay(1500, 3000);
    await this._clickPost();
    await sleep(4000);
    const post2 = await this._toast();
    if (post2) return { ok: false, reason: `anti_automation:${post2}` };
    return { ok: true };
  }

  /**
   * Post a thread: tweet[0] as an original, each subsequent tweet as a reply to
   * the previous one (self-thread). Confirms each tweet's URL from the profile so
   * the next reply chains to it — the same mechanism post() uses.
   * @param {string[]} tweets  ordered tweet bodies (>=1)
   * @returns {Promise<{ok:boolean, urls:(string|null)[], reason?:string, dryRun?:boolean}>}
   */
  async postThread(tweets, { dryRun = false } = {}) {
    const urls = [];
    const first = await this.post(tweets[0], { dryRun });
    if (dryRun) return { ok: false, dryRun: true, urls };
    if (!first.posted) return { ok: false, reason: `tweet1:${first.reason || "failed"}`, urls };
    urls.push(first.url || null);

    // Chain replies to the last confirmed URL. If tweet1's URL wasn't captured,
    // try once more to recover it — without a root URL we can't thread.
    let prev = first.url || (await this._confirmFromProfile(tweets[0]).catch(() => null));
    for (let i = 1; i < tweets.length; i++) {
      if (!prev) { this.log(`thread: no URL to chain tweet${i + 1} onto — stopping (tweet1 is live)`); urls.push(null); break; }
      const r = await this.reply(prev, tweets[i], { dryRun });
      if (!r.ok) { this.log(`thread: tweet${i + 1} reply failed (${r.reason})`); urls.push(null); continue; }
      const u = await this._confirmFromProfile(tweets[i]).catch(() => null);
      urls.push(u || null);
      if (u) prev = u; // chain the next reply to this one; else keep the last good URL
    }
    return { ok: true, urls };
  }

  /**
   * Update the account bio via x.com/settings/profile. The bio field is a plain
   * (React-controlled) textarea — set its value with the native setter + input
   * event, then click Save. Not the tweet composer, so no insert-text quirks.
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async setBio(text, { dryRun = false } = {}) {
    if (!(await this._gotoChecked("https://x.com/settings/profile"))) return { ok: false, reason: "navigation_failed" };
    await sleep(2500);
    const SEL = 'textarea[name="description"], [data-testid="ocfEnterTextTextInput"]';
    const found = await this.c.evalFn(this.tab, (s) => !!document.querySelector(s), SEL);
    if (!found) return { ok: false, reason: "bio_field_not_found" };
    if (dryRun) { this.log("DRY RUN — bio field located, not saving"); return { ok: false, reason: "dry_run", dryRun: true }; }

    const set = await this.c.evalFn(this.tab, (a) => {
      const el = document.querySelector(a.s);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
      setter.call(el, a.t);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { s: SEL, t: text });
    if (!set) return { ok: false, reason: "bio_set_failed" };
    await sleep(800);

    const saved = await this.c.evalFn(this.tab, () => {
      const btns = Array.from(document.querySelectorAll("[data-testid='Profile_Save_Button'], button"));
      const b = btns.find((x) => x.getAttribute("data-testid") === "Profile_Save_Button" || (x.textContent || "").trim() === "Save");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!saved) return { ok: false, reason: "save_button_not_found" };
    await sleep(3000);
    return { ok: true };
  }

  /**
   * Open a tweet's ⋯ menu and click the item whose label includes `labelIncludes`
   * (e.g. "delete", "pin"), then confirm. Targets the article matching the status
   * id so it doesn't act on an ancestor tweet on a permalink page.
   * dryRun stops after locating the menu item (before clicking it) — safe.
   */
  async _tweetMenuAction(tweetUrl, labelIncludes, { dryRun = false } = {}) {
    if (!(await this._gotoChecked(tweetUrl))) return { ok: false, reason: "navigation_failed" };
    await sleep(2500);
    const id = (tweetUrl.match(/\/status\/(\d+)/) || [])[1] || "";
    const opened = await this.c.evalFn(this.tab, (i) => {
      const arts = Array.from(document.querySelectorAll("article"));
      const target = (i && arts.find((a) => a.querySelector(`a[href*="/status/${i}"]`))) || arts[0];
      const caret = target && target.querySelector("[data-testid='caret']");
      if (caret) { caret.click(); return true; }
      return false;
    }, id);
    if (!opened) return { ok: false, reason: "menu_not_found" };
    await sleep(1000);
    const hasItem = await this.c.evalFn(this.tab, (lbl) =>
      Array.from(document.querySelectorAll("[role='menuitem']")).some((m) => (m.innerText || "").toLowerCase().includes(lbl)), labelIncludes);
    if (!hasItem) return { ok: false, reason: "menu_item_not_found" };
    if (dryRun) { this.log(`DRY RUN — '${labelIncludes}' menu item located, not clicking`); return { ok: false, reason: "dry_run", dryRun: true }; }
    await this.c.evalFn(this.tab, (lbl) => {
      const it = Array.from(document.querySelectorAll("[role='menuitem']")).find((m) => (m.innerText || "").toLowerCase().includes(lbl));
      if (it) it.click();
    }, labelIncludes);
    await sleep(900);
    const confirmed = await this.c.evalFn(this.tab, (lbl) => {
      const b = document.querySelector("[data-testid='confirmationSheetConfirm']");
      if (b) { b.click(); return true; }
      const alt = Array.from(document.querySelectorAll("button")).find((x) => (x.innerText || "").trim().toLowerCase().includes(lbl));
      if (alt) { alt.click(); return true; }
      return false;
    }, labelIncludes);
    await sleep(2000);
    return { ok: true, confirmed: !!confirmed };
  }

  /** Delete one of our tweets by URL. */
  async deleteTweet(tweetUrl, opts = {}) { return this._tweetMenuAction(tweetUrl, "delete", opts); }

  /** Pin one of our tweets to the profile by URL. */
  async pinTweet(tweetUrl, opts = {}) { return this._tweetMenuAction(tweetUrl, "pin", opts); }

  /** Find one of our own tweets on the profile whose text contains `fragment`; returns its status URL or null. */
  async findOwnTweetUrl(fragment, { limit = 20 } = {}) {
    if (!(await this._gotoChecked(`https://x.com/${this.ownHandle}`))) return null;
    await sleep(3000);
    return this.c.evalFn(this.tab, (a) => {
      const arts = Array.from(document.querySelectorAll("article")).slice(0, a.limit);
      for (const art of arts) {
        if (art.innerText && art.innerText.includes(a.frag)) {
          const link = art.querySelector("a[href*='/status/']");
          if (link) return "https://x.com" + link.getAttribute("href").split("?")[0];
        }
      }
      return null;
    }, { frag: fragment, limit });
  }

  /**
   * Publish a native X Article (long-form). Flow (verified 2026-07-06 on a
   * Premium account): x.com/compose/articles is the LANDING page (drafts list) —
   * click "Write" to open a fresh editor at /compose/articles/edit/<id>, which
   * has a title field, a body contenteditable (aria-label "composer"/"Body"),
   * and a Publish button. dryRun stops once the editor is open.
   * Returns { ok, url } (url best-effort from the profile).
   */
  async postArticle({ title, body }, { dryRun = false } = {}) {
    if (!(await this._gotoChecked("https://x.com/compose/articles"))) return { ok: false, reason: "navigation_failed" };
    await sleep(4000);

    // Open a new article draft: empty-state "Write" button, or the top "create".
    await this.c.evalFn(this.tab, () => {
      const b = document.querySelector("[data-testid=empty_state_button_text]") ||
        Array.from(document.querySelectorAll("button,[role=button]")).find((e) => /^write$|create/i.test((e.innerText || e.getAttribute("aria-label") || "").trim()));
      if (b) (b.closest("button,[role=button]") || b).click();
    });
    // Wait for the editor route to load.
    try {
      await this.c.pollFn(this.tab, "article editor", () =>
        /\/compose\/articles\/edit\//.test(location.href) && document.querySelectorAll('[role="textbox"],[contenteditable="true"]').length > 0,
        { attempts: 12, interval: 1000, tag: "x" });
    } catch { return { ok: false, reason: "editor_not_found" }; }

    if (dryRun) { this.log("DRY RUN — article editor opened, not publishing"); return { ok: false, reason: "dry_run", dryRun: true }; }

    // Title: a textbox/input that isn't the body composer. Body: the composer.
    const focusTitle = () => this.c.evalFn(this.tab, () => {
      const el = document.querySelector('input[aria-label*="Title" i], [role="textbox"][aria-label*="Title" i], [data-testid*="itle"]') ||
        Array.from(document.querySelectorAll('[role="textbox"],[contenteditable="true"]')).find((e) => !/composer|body/i.test(e.getAttribute("aria-label") || ""));
      if (el) { el.focus(); return true; } return false;
    });
    const focusBody = () => this.c.evalFn(this.tab, () => {
      const el = document.querySelector('[aria-label="Body"], [contenteditable="true"][aria-label*="composer" i]') ||
        Array.from(document.querySelectorAll('[contenteditable="true"],[role="textbox"]')).pop();
      if (el) { el.focus(); return true; } return false;
    });

    if (title) { if (await focusTitle()) { await this.c.insertText(this.tab, title); await sleep(700); } }
    if (await focusBody()) {
      for (let i = 0; i < body.length; i += 400) { await this.c.insertText(this.tab, body.slice(i, i + 400)); await sleep(120); }
    } else { return { ok: false, reason: "body_field_not_found" }; }
    await sleep(1200);

    // Publish (may require a second confirm-Publish in a dialog).
    const clickPublish = () => this.c.evalFn(this.tab, () => {
      const cands = ['[data-testid="publishButton"]', '[data-testid="articlePublishButton"]', '[data-testid*="ublish"]'];
      for (const sel of cands) { const b = document.querySelector(sel); if (b && !b.disabled) { b.click(); return true; } }
      const b2 = Array.from(document.querySelectorAll("button,[role=button]")).find((x) => ["publish", "post"].includes((x.innerText || x.getAttribute("aria-label") || "").trim().toLowerCase()) && !x.disabled);
      if (b2) { b2.click(); return true; }
      return false;
    });
    if (!(await clickPublish())) return { ok: false, reason: "publish_button_not_found" };
    await sleep(1500);
    await clickPublish().catch(() => {}); // confirm dialog, if any
    await sleep(5000);
    const url = await this._confirmFromProfile((title || body).slice(0, 40)).catch(() => null);
    return { ok: true, url: url || null };
  }

  /**
   * Follow a user from their profile page.
   * @param {string} username Handle without @.
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   *   reason: "profile_not_loaded" | "already_following" |
   *   "follow_button_not_found" | "anti_automation:*" | "dry_run"
   */
  async follow(username, { dryRun = false } = {}) {
    if (!(await this._gotoChecked(`https://x.com/${username}`))) {
      return { ok: false, reason: "navigation_failed" };
    }
    try {
      await this.c.pollFn(this.tab, "profile column", () => !!document.querySelector('[data-testid="primaryColumn"]'), { attempts: 12, interval: 1000, tag: "x" });
    } catch {
      return { ok: false, reason: "profile_not_loaded" };
    }
    await sleep(2000);
    const state = await this.c.evalFn(this.tab, (u, dry) => {
      if (document.querySelector('[data-testid$="-unfollow"], [aria-label^="Following @"]')) return "already";
      const btn =
        document.querySelector(`[aria-label="Follow @${u}"]`) ||
        document.querySelector('[data-testid="placementTracking"] [aria-label*="Follow"]') ||
        document.querySelector('[data-testid="userActions"] [aria-label*="Follow"]') ||
        document.querySelector('[data-testid$="-follow"]');
      if (!btn) return "missing";
      if (dry) return "would_click";
      btn.click();
      return "clicked";
    }, username, dryRun);
    if (state === "already") return { ok: false, reason: "already_following" };
    if (state === "missing") return { ok: false, reason: "follow_button_not_found" };
    if (state === "would_click") {
      this.log(`DRY RUN — would follow @${username}`);
      return { ok: false, reason: "dry_run", dryRun: true };
    }
    await sleep(2000);
    const toast = await this._toast();
    if (toast) return { ok: false, reason: `anti_automation:${toast}` };
    const confirmed = await this.c.evalFn(this.tab, () =>
      !!document.querySelector('[data-testid$="-unfollow"], [aria-label^="Following @"]')
    ).catch(() => false);
    if (!confirmed) this.log(`follow @${username}: click registered but Following state not visible yet`);
    return { ok: true };
  }

  // ── Browse (mechanical timeline read) ───────────────────────────────────────
  /**
   * Scrape the home timeline, accumulating across scroll steps — X virtualizes
   * the feed aggressively, so a single scrape after scrolling only sees the
   * last viewport (~5 posts). Articles are stamped with a page-lifetime unique
   * data-hs-idx (window.__hsIdx counter) so likeByIdx targets stay valid across
   * passes; posts scrolled out of the DOM simply fail their like gracefully.
   * @returns {Promise<Array<{idx:number, handle:string, text:string, tweetId:string, url:string, liked:boolean}>>}
   */
  async scrapeTimeline({ limit = 15, scrolls = 3 } = {}) {
    await this.gotoHome();
    const seen = new Map();
    const grab = async () => {
      const raw = await this.c.evalFn(this.tab, (max) => {
        const arts = [].slice.call(document.querySelectorAll("article[data-testid=tweet]"));
        window.__hsIdx = window.__hsIdx || 0;
        const out = [];
        for (let i = 0; i < arts.length && out.length < max; i++) {
          const a = arts[i];
          const statusHref = [].slice.call(a.querySelectorAll('a[href*="/status/"]'))
            .map((x) => x.getAttribute("href")).find((h) => /\/status\/\d+$/.test(h) || /\/status\/\d+/.test(h));
          if (!statusHref) continue;
          const m = statusHref.match(/^\/([^/]+)\/status\/(\d+)/);
          if (!m) continue;
          if (!a.hasAttribute("data-hs-idx")) a.setAttribute("data-hs-idx", String(window.__hsIdx++));
          const textEl = a.querySelector("[data-testid=tweetText]");
          out.push({
            idx: parseInt(a.getAttribute("data-hs-idx"), 10),
            handle: m[1],
            tweetId: m[2],
            url: `https://x.com/${m[1]}/status/${m[2]}`,
            text: (textEl ? textEl.innerText : "").slice(0, 600),
            liked: !!a.querySelector("[data-testid=unlike]"),
          });
        }
        return JSON.stringify(out);
      }, limit);
      let parsed = [];
      try { parsed = JSON.parse(raw || "[]"); } catch { parsed = []; }
      for (const p of parsed) if (!seen.has(p.tweetId)) seen.set(p.tweetId, p);
    };

    await grab();
    let dry = 0;
    for (let i = 0; i < scrolls * 3 && seen.size < limit && dry < 2; i++) {
      const before = seen.size;
      await this.c.evaluate(this.tab, "window.scrollBy(0, window.innerHeight*1.5)").catch(() => {});
      await sleep(1500);
      await grab();
      dry = seen.size === before ? dry + 1 : 0;
    }
    return Array.from(seen.values())
      .filter((p) => (p.handle || "").toLowerCase() !== this.handle.toLowerCase())
      .slice(0, limit);
  }

  /**
   * Full-fidelity article extractor — ported from scraper/collect.js `extractPosts`
   * so the scraper collector can run over HelmStack instead of raw CDP. Runs the
   * DOM scrape in-page via evalFn and returns the parsed array. Unlike
   * scrapeTimeline() it does NOT filter the bot's own handle (the collector's
   * sanitize/seen layers handle that) and returns the rich field set the
   * collector's scoring/DB/digest depend on.
   *
   * @returns {Promise<Array<{id,username,displayName,text,quotedText,quotedUsername,ts,likes,rts,replies,mediaType,mediaUrl,externalUrls}>>}
   */
  async _scrapeArticles(max) {
    const raw = await this.c.evalFn(this.tab, (max) => {
      const results = [];
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const art of articles) {
        if (results.length >= max) break;
        try {
          const link = art.querySelector('a[href*="/status/"]');
          if (!link) continue;
          const match = link.href.match(/\/status\/(\d+)/);
          if (!match) continue;
          const id = match[1];

          const userEl = art.querySelector('[data-testid="User-Name"]');
          const usernameEl = userEl ? userEl.querySelector('a[href^="/"]') : null;
          const username = usernameEl && usernameEl.href ? usernameEl.href.split("/").pop() : "";
          const displayName = (userEl && userEl.querySelector("span") ? userEl.querySelector("span").innerText : "") || username;

          const textEls = art.querySelectorAll('[data-testid="tweetText"]');
          const text = (textEls[0] ? textEls[0].innerText : "") || "";
          const quotedText = textEls[1] ? (textEls[1].innerText || "").trim() : "";
          const allUserEls = art.querySelectorAll('[data-testid="User-Name"]');
          const quotedUserEl = allUserEls[1] || null;
          const qUEl = quotedUserEl ? quotedUserEl.querySelector('a[href^="/"]') : null;
          const quotedUsername = qUEl && qUEl.href ? qUEl.href.split("/").pop() : "";

          const externalUrls = [];
          const anchors = art.querySelectorAll("a[href]");
          for (const anchor of anchors) {
            const href = anchor.href || "";
            try {
              const parsed = new URL(href);
              const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
              if (host === "x.com" || host === "twitter.com") continue;
              if (!/^https?:$/.test(parsed.protocol)) continue;
              externalUrls.push(parsed.toString());
            } catch (_) {}
          }

          const timeEl = art.querySelector("time");
          const ts = timeEl ? new Date(timeEl.getAttribute("datetime")).getTime() : Date.now();

          const likeEl = art.querySelector('[data-testid="like"]');
          const rtEl = art.querySelector('[data-testid="retweet"]');
          const replyEl = art.querySelector('[data-testid="reply"]');
          const likes = (likeEl ? likeEl.innerText : "") || "0";
          const rts = (rtEl ? rtEl.innerText : "") || "0";
          const replies = (replyEl ? replyEl.innerText : "") || "0";

          const imgEl = art.querySelector('[data-testid="tweetPhoto"] img');
          const videoEl = art.querySelector('[data-testid="videoPlayer"]')
            || art.querySelector('[data-testid="videoComponent"]')
            || art.querySelector("video");
          const mediaType = videoEl ? "video" : (imgEl ? "image" : "none");
          let mediaUrl = "";
          if (imgEl && imgEl.src) mediaUrl = imgEl.src;
          else {
            const posterEl = art.querySelector("video[poster]");
            if (posterEl) mediaUrl = posterEl.getAttribute("poster") || "";
          }

          results.push({ id, username, displayName, text, quotedText, quotedUsername, ts, likes, rts, replies, mediaType, mediaUrl, externalUrls });
        } catch (_) {}
      }
      return JSON.stringify(results);
    }, max);
    try { return JSON.parse(raw || "[]"); } catch { return []; }
  }

  /**
   * Home timeline, full fields. Accumulates across scroll steps (deduped by
   * tweet id) — X virtualizes the feed, so scraping once after scrolling only
   * sees the last viewport (~5 posts). Scrolls up to 3× the requested count,
   * stopping early when the limit is reached or two consecutive scrolls yield
   * nothing new.
   */
  async scrapeTimelineFull({ limit = 30, scrolls = 3 } = {}) {
    await this.gotoHome();
    const seen = new Map();
    const grab = async () => {
      for (const p of await this._scrapeArticles(limit)) {
        if (p.id && !seen.has(p.id)) seen.set(p.id, p);
      }
    };
    await grab();
    let dry = 0;
    for (let i = 0; i < scrolls * 3 && seen.size < limit && dry < 2; i++) {
      const before = seen.size;
      await this.c.evaluate(this.tab, "window.scrollBy(0, 1200)").catch(() => {});
      await sleep(1200);
      await grab();
      dry = seen.size === before ? dry + 1 : 0;
    }
    return Array.from(seen.values());
  }

  /**
   * The conversation visible on a tweet permalink, in DOM order: ancestor
   * tweets first, then the focused tweet, then replies below. Unlike
   * scrapeThreadReplies() nothing is dropped — callers that need "what came
   * before this tweet" (e.g. mention-reply context) slice it themselves.
   */
  async scrapeConversation(tweetUrl, { limit = 6 } = {}) {
    if (!(await this._gotoChecked(tweetUrl))) return [];
    await sleep(1500);
    return this._scrapeArticles(limit);
  }

  /** Top replies under a tweet permalink (drops the root tweet). */
  async scrapeThreadReplies(tweetUrl, { limit = 10 } = {}) {
    if (!(await this._gotoChecked(tweetUrl))) return [];
    await sleep(1500);
    const all = await this._scrapeArticles(limit + 3);
    return all.slice(1); // caller filters/sorts/slices
  }

  /** Mentions from the notifications page. */
  async scrapeMentions({ limit = 20 } = {}) {
    await this._gotoChecked("https://x.com/notifications/mentions");
    await sleep(2000);
    const url = await this.c.tabUrl(this.tab).catch(() => "");
    if (url && !/notifications/.test(url)) return [];
    await this.c.evaluate(this.tab, "window.scrollBy(0, 800)").catch(() => {});
    await sleep(1000);
    return this._scrapeArticles(limit);
  }

  /** Like a scraped tweet by index. Returns true if it registered. */
  async likeByIdx(idx, { dryRun = false } = {}) {
    if (dryRun) return true;
    const ok = await this._eval(
      `var a=document.querySelector('article[data-hs-idx=\"${idx}\"]');
       if(!a) return false;
       if(a.querySelector('[data-testid=unlike]')) return 'already';
       var b=a.querySelector('[data-testid=like]');
       if(!b) return false; b.click(); return true;`
    ).catch(() => false);
    await sleep(1200);
    return ok === true || ok === "already";
  }

  /**
   * High-level engagement: scrape → score → like top-N → reply top-M.
   * All app decisions injected (mirror of LinkedIn.engage).
   *
   * @param {object} hooks
   * @param {(post)=>number} hooks.score
   * @param {(post)=>Promise<string|null>} [hooks.generateReply]
   * @param {(post,meta)=>Promise<void>} [hooks.onLike]
   * @param {(post,text,meta)=>Promise<void>} [hooks.onReply]
   * @param {(post)=>string} [hooks.keyOf]
   * @param {Set<string>} [hooks.seen]
   * @param {number} [hooks.minScore=1]
   * @param {number} [hooks.maxLikes=3]
   * @param {number} [hooks.maxReplies=1]
   * @param {number} [hooks.scrapeLimit=15]
   * @param {boolean} [hooks.dryRun=false]
   * @returns {Promise<{scraped:number, likes:number, replies:number, ranked:number}>}
   */
  async engage(hooks = {}) {
    const {
      score = () => 0, generateReply = null, onLike = null, onReply = null,
      keyOf = (p) => p.url, seen = new Set(),
      minScore = 1, maxLikes = 3, maxReplies = 1, scrapeLimit = 15, dryRun = false,
    } = hooks;

    const posts = await this.scrapeTimeline({ limit: scrapeLimit });
    this.log(`scraped ${posts.length} timeline post(s)`);
    // score() may be sync or async (e.g. an LLM relevance scorer) — await either.
    const scored = await Promise.all(
      posts.map(async (p) => ({ ...p, key: keyOf(p), score: await score(p) }))
    );
    const ranked = scored
      .filter((p) => !seen.has(p.key) && p.score >= minScore)
      .sort((a, b) => b.score - a.score);
    this.log(`${ranked.length} relevant, un-engaged post(s) (min score ${minScore})`);

    let likes = 0;
    for (const p of ranked.slice(0, maxLikes)) {
      if (p.liked) { seen.add(p.key); continue; }
      if (await this.likeByIdx(p.idx, { dryRun })) {
        likes++; seen.add(p.key);
        this.log(`${dryRun ? "[dry] " : ""}liked @${p.handle} (score ${p.score})`);
        if (!dryRun && onLike) await onLike(p, { score: p.score });
      }
    }

    let replies = 0;
    if (generateReply) {
      for (const p of ranked.slice(0, maxReplies)) {
        const text = await generateReply(p);
        if (!text) continue;
        const res = await this.reply(p.url, text, { dryRun });
        if (res.dryRun) { this.log(`[dry] would reply to @${p.handle}: "${text.slice(0, 60)}..."`); replies++; continue; }
        if (res.ok) {
          replies++; seen.add(p.key);
          this.log(`replied to @${p.handle}: "${text.slice(0, 60)}..."`);
          if (onReply) await onReply(p, text, { score: p.score });
        } else {
          this.log(`reply failed for @${p.handle} (${res.reason})`);
        }
      }
    }

    return { scraped: posts.length, likes, replies, ranked: ranked.length };
  }
}

module.exports = { X, X_HOME_URL: HOME_URL };
