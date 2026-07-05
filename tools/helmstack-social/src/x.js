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
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor(client, { ownHandle = "SebastianHunts", log } = {}) {
    this.c = client;
    this.handle = ownHandle;
    this.log = log || ((m) => console.log(`[x] ${m}`));
    this.tab = null;
  }

  async _eval(body, timeout = 20000) {
    return this.c.evaluate(this.tab, `(function(){${body}\n})()`, { timeout });
  }

  // ── Session / tab ───────────────────────────────────────────────────────────
  async ensureTab() {
    this.tab = await this.c.ensureTab(/https:\/\/(www\.)?(x|twitter)\.com/, HOME_URL);
    // A freshly-opened tab may not have its session cookies readable yet; wait
    // for it to settle so sessionOk() doesn't get a false negative.
    await this.c.waitReady(this.tab, { tag: "x", attempts: 15 }).catch(() => {});
    return this.tab;
  }

  async sessionOk() {
    try {
      const cookies = await this.c.getCookies(this.tab);
      const names = cookies.map((k) => k.name);
      return names.includes("auth_token") && names.includes("ct0");
    } catch {
      return false;
    }
  }

  async gotoHome() {
    await this.c.navigate(this.tab, HOME_URL);
    await this.c.waitReady(this.tab, { tag: "x" });
    await sleep(2500);
  }

  // ── Composer helpers (top-frame) ────────────────────────────────────────────
  /** Insert text into the (already-open) composer and verify an exact match. */
  async _insertVerified(text) {
    await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) { e.click(); e.focus(); } }, COMPOSE_BOX);
    await humanDelay(1500, 3000);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) { e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } }, COMPOSE_BOX);
      await sleep(400);
      await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) { e.click(); e.focus(); } }, COMPOSE_BOX);
      await sleep(300);
      try {
        await this.c.insertText(this.tab, text);
      } catch {
        await this.c.evalFn(this.tab, (t, sel) => { const e = document.querySelector(sel); if (e) { e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); document.execCommand("insertText", false, t); } }, text, COMPOSE_BOX);
      }
      await sleep(1500);
      const got = await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); return e ? e.innerText.trim() : ""; }, COMPOSE_BOX);
      if (got === text.trim()) return true;
      this.log(`text verify miss ${attempt}/2 (${got.length}/${text.length})`);
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
    await this.c.navigate(this.tab, `https://x.com/${this.handle}`);
    await this.c.waitReady(this.tab, { tag: "x" });
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
   * Reply to a tweet.
   * @param {string} tweetUrl  the target status URL
   */
  async reply(tweetUrl, text, { dryRun = false } = {}) {
    await this.c.navigate(this.tab, tweetUrl);
    await this.c.waitReady(this.tab, { tag: "x" });
    await sleep(3000);
    // Click the reply affordance on the focused (first) tweet
    const clicked = await this.c.evalFn(this.tab, () => {
      const a = document.querySelector("article");
      const b = a && a.querySelector('[data-testid="reply"]');
      if (b) { b.click(); return true; }
      return false;
    });
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

  // ── Browse (mechanical timeline read) ───────────────────────────────────────
  /**
   * Scrape the home timeline. Stamps each tweet article with data-hs-idx.
   * @returns {Promise<Array<{idx:number, handle:string, text:string, tweetId:string, url:string, liked:boolean}>>}
   */
  async scrapeTimeline({ limit = 15 } = {}) {
    await this.gotoHome();
    for (let i = 0; i < 3; i++) {
      await this.c.evaluate(this.tab, "window.scrollBy(0, window.innerHeight*1.5)").catch(() => {});
      await sleep(1500);
    }
    await this.c.evaluate(this.tab, "window.scrollTo(0,0)").catch(() => {});
    await sleep(800);

    const raw = await this.c.evalFn(this.tab, (max) => {
      const arts = [].slice.call(document.querySelectorAll("article[data-testid=tweet]"));
      const out = [];
      for (let i = 0; i < arts.length && out.length < max; i++) {
        const a = arts[i];
        const statusHref = [].slice.call(a.querySelectorAll('a[href*="/status/"]'))
          .map((x) => x.getAttribute("href")).find((h) => /\/status\/\d+$/.test(h) || /\/status\/\d+/.test(h));
        if (!statusHref) continue;
        const m = statusHref.match(/^\/([^/]+)\/status\/(\d+)/);
        if (!m) continue;
        a.setAttribute("data-hs-idx", String(out.length));
        const textEl = a.querySelector("[data-testid=tweetText]");
        out.push({
          idx: out.length,
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
    return parsed.filter((p) => (p.handle || "").toLowerCase() !== this.handle.toLowerCase());
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
