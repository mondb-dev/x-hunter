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
// X's public web bearer (used by the logged-in web client). Auth is completed by
// the session cookies + ct0 CSRF; this constant is the same for every web user.
const X_WEB_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const COMPOSE_BOX = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

// X's composer inserts some non-ASCII punctuation unreliably via Input.insertText
// (em/en dashes, smart quotes, ellipsis get dropped or altered) — the per-line
// verify then never matches the expected text and the post ABORTS. Normalizing to
// ASCII at the single insert chokepoint keeps expected == inserted and yields
// clean posted text. Composed replies (LLM output) are full of these characters.
const toComposerSafe = (s) => String(s || "")
  .replace(/[—–]/g, "-")        // em/en dash → hyphen
  .replace(/…/g, "...")               // ellipsis → three dots
  .replace(/[‘’‛]/g, "'")   // smart single quotes → '
  .replace(/[“”]/g, '"')         // smart double quotes → "
  .replace(/[   ]/g, " ");  // nbsp / narrow / thin space → space

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
    // Use the checked navigation (verifies landing, recycles a wedged tab) rather
    // than a bare navigate: a post attempt leaves the tab on /compose/post with an
    // open composer, and if that navigation snaps back (the wedged-tab bug) the
    // NEXT post would run on the stuck compose page — its composer "won't clear",
    // so every post aborts until the tab is manually closed. _gotoChecked recycles
    // the tab instead, so posting self-heals from a stuck compose state.
    if (!(await this._gotoChecked(HOME_URL))) {
      this.log("could not land on /home — proceeding (compose-box poll will guard)");
    }
    await sleep(2000);
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
    for (let t = 0; t < 4; t++) {
      // execCommand path — works when there's no link chip in the composer.
      await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); if (e) { e.focus(); document.execCommand("selectAll"); document.execCommand("delete"); } }, COMPOSE_BOX);
      await sleep(350);
      if (await isEmpty()) return true;
      // Key path — needed once a link chip is present (execCommand breaks then).
      // Select-all (Cmd+A on macOS), then several Backspaces AND a Delete, since
      // a link chip can survive a single deletion.
      await this._focusComposer();
      await this.c.pressKey(this.tab, { key: "a", code: "KeyA", keyCode: 65, modifiers: 4 }).catch(() => {});
      await sleep(200);
      for (let b = 0; b < 4; b++) {
        await this.c.pressKey(this.tab, { key: "Backspace", code: "Backspace", keyCode: 8 }).catch(() => {});
        await sleep(150);
      }
      await this.c.pressKey(this.tab, { key: "a", code: "KeyA", keyCode: 65, modifiers: 4 }).catch(() => {});
      await sleep(150);
      await this.c.pressKey(this.tab, { key: "Delete", code: "Delete", keyCode: 46 }).catch(() => {});
      await sleep(350);
      if (await isEmpty()) return true;
    }
    return isEmpty();
  }

  /**
   * Hard-discard whatever is in the composer AND X's persisted draft, closing any
   * open compose modal. CRITICAL: when an insert aborts, X saves the typed text as
   * a DRAFT and restores it into the NEXT compose cycle — where fresh text piles
   * onto it. That is how two unrelated tweets + warm-up "." dots end up stacked and
   * multiplied in one posted tweet, even though every attempt logged
   * `text_insert_failed`. So every abort path must call this: an empty draft can't
   * accumulate or auto-post.
   */
  async _discardComposer() {
    await this._clearComposer().catch(() => {});               // inline-composer case
    // Modal case: Escape raises X's "Save / Discard" sheet — click Discard.
    await this.c.pressKey(this.tab, { key: "Escape", code: "Escape", keyCode: 27 }).catch(() => {});
    await sleep(600);
    const discarded = await this.c.evalFn(this.tab, () => {
      const btns = Array.from(document.querySelectorAll('[data-testid="confirmationSheetConfirm"],[role="button"],button'));
      const d = btns.find((b) => /^(discard|delete)$/i.test((b.innerText || "").trim()));
      if (d) { d.click(); return true; }
      return false;
    }).catch(() => false);
    await sleep(600);
    return discarded;
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
    text = toComposerSafe(text);   // ASCII-normalize so the verify can't fail on smart punctuation
    await this._focusComposer();
    await humanDelay(1500, 3000);
    // Warm up the input channel: the first insertText into a fresh modal is
    // silently buffered (it flushes, doubled, with a later call). Poke with a
    // probe char until something visibly registers, then clear it. ONLY when the
    // composer is empty — if a draft was restored, the channel is already proven
    // and probing would just stamp a stray "." onto that draft (the "....." seen
    // between stacked tweets), which then rides along if a later clear misses.
    const hasDraft = await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); return e ? e.innerText.trim().length > 0 : false; }, COMPOSE_BOX).catch(() => false);
    if (!hasDraft) {
      for (let t = 0; t < 4; t++) {
        await this.c.insertText(this.tab, ".").catch(() => {});
        await sleep(400);
        const seen = await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); return e ? e.innerText.trim().length > 0 : false; }, COMPOSE_BOX);
        if (seen) break;
      }
    }
    // Never insert into a non-empty composer — leftover text makes insertText
    // APPEND, stacking duplicate copies (the "…fact.EU announces…" ×4 bug).
    if (!(await this._clearComposer())) { this.log("composer would not clear before insert — discarding draft + aborting"); await this._discardComposer(); return false; }
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
      // Must fully clear before retrying, or the next insert appends onto the
      // miss and compounds into duplicated text. If it won't clear, abort.
      if (!(await this._clearComposer())) { this.log("composer would not clear after miss — discarding draft + aborting"); await this._discardComposer(); return false; }
    }
    // All attempts missed: the text landed somewhere the verifier can't see (a
    // stray modal / restored draft). Discard so it can't accumulate or auto-post.
    this.log("insert unverified after 3 attempts — discarding draft");
    await this._discardComposer();
    return false;
  }

  /**
   * Final anti-duplication guard, run immediately before clicking Post.
   * `_insertVerified` confirms the composer at verify time, but X holds the last
   * insert in a buffer that flushes on the NEXT input event — so a duplicate can
   * flush during the human delay / post-button polling that follows, doubling or
   * tripling the text after it was verified. This re-reads the composer as late as
   * possible: if it drifted, it clears + reinserts once, and returns false (caller
   * aborts) if it STILL doesn't exactly match — we never publish doubled text.
   * @returns {Promise<boolean>} safe to post
   */
  async _settleComposer(text) {
    const safe = toComposerSafe(text);
    const read = async () => norm(await this.c.evalFn(this.tab, (sel) => { const e = document.querySelector(sel); return e ? e.innerText : ""; }, COMPOSE_BOX).catch(() => ""));
    await sleep(1200); // let any buffered flush land before the final check
    if (await read() === norm(safe)) return true;
    this.log("composer drifted after verify (late buffer flush) — reinserting once");
    if (!(await this._clearComposer())) { this.log("composer would not clear pre-post — aborting"); return false; }
    if (!(await this._insertVerified(safe))) return false;
    await sleep(1200);
    if ((await read()) === norm(safe)) return true;
    this.log("composer still mismatched pre-post — discarding draft + aborting to avoid duplicate");
    await this._discardComposer();
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
  /**
   * Publish a tweet. Prefers X's internal CreateTweet GraphQL API (an in-page
   * fetch authed by the session's ct0 CSRF token) — NO composer, so none of the
   * composer's insert/duplication/draft-restore failure modes apply. Falls back
   * to the UI composer only if the API path is unavailable. X_POST_VIA_API=0
   * forces the composer.
   */
  async post(text, { dryRun = false } = {}) {
    if (process.env.X_POST_VIA_API !== "0") {
      const api = await this.postViaApi(text, { dryRun });
      if (api.posted || api.dryRun) return api;
      this.log(`API post unavailable (${api.reason}) — falling back to composer`);
    }
    return this._postViaComposer(text, { dryRun });
  }

  /**
   * Extract (and cache, per operation) a rotating GraphQL queryId from the
   * loaded JS bundle — CreateTweet, CreateRetweet, DeleteRetweet, etc.
   * Assumes an x.com page is loaded in the tab (callers guard navigation).
   */
  async _graphqlQueryId(opName, { force = false } = {}) {
    this._qids = this._qids || {};
    if (this._qids[opName] && !force) return this._qids[opName];
    // Use c.evaluate directly (not _eval, which wraps in a SYNC fn and would drop
    // this async IIFE's promise). The in-page script-source fetch is occasionally
    // flaky (empty result), so try a couple of times before giving up.
    const extract = () => this.c.evaluate(this.tab,
      `(async function(){
         var op=${JSON.stringify(opName)};
         var srcs=[].slice.call(document.querySelectorAll('script[src]')).map(function(s){return s.src;})
           .filter(function(u){return /main\\.[a-f0-9]+\\.js/.test(u)||/(api|responsive-web)[^/]*\\.[a-f0-9]+\\.js/.test(u);});
         for(var i=0;i<srcs.length;i++){ try{ var txt=await (await fetch(srcs[i])).text();
           var m=txt.match(new RegExp('queryId:"([^"]+)",operationName:"'+op+'"'))||txt.match(new RegExp('operationName:"'+op+'"[^}]*?queryId:"([^"]+)"'));
           if(m) return m[1]; }catch(e){} }
         return "";
       })()`, { timeout: 30000 }
    ).catch(() => "");
    let qid = "";
    for (let i = 0; i < 2 && !qid; i++) { qid = await extract(); if (!qid) await sleep(800); }
    if (qid) this._qids[opName] = qid;
    return this._qids[opName] || null;
  }

  /**
   * Run one of X's GraphQL mutations in-page (session-authed: ct0 CSRF + the
   * public web bearer — the same machinery postViaApi validated live). Retries
   * once with a re-extracted queryId if the cached one has rotated (non-200).
   * @returns {Promise<{status?:number, json?:object, raw?:string, error?:string}>}
   */
  async _graphqlMutation(opName, variables, { withFeatures = false } = {}) {
    const cur = await this.c.tabUrl(this.tab).catch(() => "");
    if (!/x\.com|twitter\.com/.test(cur)) { if (!(await this._gotoChecked(HOME_URL))) return { error: "nav_failed" }; }
    const qid = await this._graphqlQueryId(opName);
    if (!qid) return { error: "no_queryid" };

    const doCall = async (queryId) => {
      const body = withFeatures ? { variables, features: {}, queryId } : { variables, queryId };
      const expr = `(async function(){
        var ct0=(document.cookie.match(/ct0=([^;]+)/)||[])[1]; if(!ct0) return JSON.stringify({error:"no_ct0"});
        try{ var r=await fetch("https://x.com/i/api/graphql/"+${JSON.stringify(queryId)}+"/"+${JSON.stringify(opName)},{method:"POST",credentials:"include",
          headers:{"authorization":"Bearer ${X_WEB_BEARER}","x-csrf-token":ct0,"content-type":"application/json","x-twitter-auth-type":"OAuth2Session","x-twitter-active-user":"yes"},body:${JSON.stringify(JSON.stringify(body))}});
          var t=await r.text(); var j=null; try{j=JSON.parse(t);}catch(e){}
          return JSON.stringify({status:r.status, json:j, raw:j?undefined:t.slice(0,200)});
        }catch(e){return JSON.stringify({error:e.message});}
      })()`;
      try { return JSON.parse(await this.c.evaluate(this.tab, expr, { timeout: 25000 })); }
      catch (e) { return { error: `eval:${e.message}` }; }
    };

    let r = await doCall(qid);
    // Retry once ONLY on a transient status — a 404 (stale/rotated queryId or a
    // routing hiccup; observed intermittently on CreateRetweet) or a 5xx. Retry
    // even if the re-extracted queryId is unchanged (the old "only if different"
    // guard is what surfaced spurious api_404s). Deterministic rejections
    // (400/401/403) and rate-limits (429) are NOT retried, so posting can't
    // double-fire on a hard rejection.
    if (r.status && (r.status === 404 || r.status >= 500)) {
      const qid2 = (await this._graphqlQueryId(opName, { force: true })) || qid;
      await sleep(600);
      r = await doCall(qid2);
    }
    return r;
  }

  /** Flatten a mutation result's error detail into a short reason string. */
  _apiReason(r) {
    const msg = (r.json?.errors || []).map((e) => e.message).join("; ") || r.error || r.raw || "";
    return `api_${r.status || "err"}:${String(msg).slice(0, 120)}`;
  }

  /**
   * Post via X's CreateTweet GraphQL mutation (in-page, session-authed). Empty
   * `features` is accepted by X, so there is no rotating-features maintenance.
   * `attachmentUrl` makes the tweet a QUOTE of that status; `replyToTweetId`
   * makes it a REPLY to that status id.
   * @returns {Promise<{posted:boolean, url?:string, reason?:string, dryRun?:boolean}>}
   */
  async postViaApi(text, { dryRun = false, attachmentUrl = null, replyToTweetId = null } = {}) {
    const cur = await this.c.tabUrl(this.tab).catch(() => "");
    if (!/x\.com|twitter\.com/.test(cur)) { if (!(await this._gotoChecked(HOME_URL))) return { posted: false, reason: "nav_failed" }; }
    const qid = await this._graphqlQueryId("CreateTweet");
    if (!qid) return { posted: false, reason: "no_queryid" };
    if (dryRun) { this.log(`DRY RUN — CreateTweet API ready (qid ${qid.slice(0, 8)}…), not posting`); return { posted: false, reason: "dry_run", dryRun: true }; }

    const variables = {
      tweet_text: text,
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
    };
    if (attachmentUrl) variables.attachment_url = String(attachmentUrl).split("?")[0];
    if (replyToTweetId) variables.reply = { in_reply_to_tweet_id: String(replyToTweetId), exclude_reply_user_ids: [] };

    const r = await this._graphqlMutation("CreateTweet", variables, { withFeatures: true });
    const id = r.json?.data?.create_tweet?.tweet_results?.result?.rest_id;
    if (id) {
      const url = `https://x.com/${this.handle || "i/web"}/status/${id}`;
      this.log(`posted via API: ${url}`);
      return { posted: true, url };
    }
    return { posted: false, reason: this._apiReason(r) };
  }

  /**
   * Post a tweet WITH an image, uploaded the real browser way — HelmStack sets the
   * composer's file input via CDP (DOM.setFileInputFiles), so X runs its own media
   * upload. Text goes through the guarded composer insert. `imagePaths` = absolute
   * path(s) on the HelmStack host; the CALLER deletes the temp file afterward.
   * @returns {Promise<{posted:boolean, url?:string|null, reason?:string, dryRun?:boolean}>}
   */
  async postImage(text, imagePaths, { dryRun = false } = {}) {
    const files = (Array.isArray(imagePaths) ? imagePaths : [imagePaths]).filter(Boolean);
    if (!files.length) return { posted: false, reason: "no_image" };
    await this.gotoHome();
    await humanDelay(1500, 2500);
    try {
      await this.c.pollFn(this.tab, "compose box", () => !!document.querySelector('[data-testid="tweetTextarea_0"]'), { attempts: 15, interval: 1000, tag: "x" });
    } catch { return { posted: false, reason: "compose_box_not_found" }; }
    await this._focusComposer();
    await sleep(600);
    try { await this.c.setFileInput(this.tab, 'input[data-testid="fileInput"]', files); }
    catch (e) { return { posted: false, reason: `file_input:${e.message}` }; }
    // Wait for X to attach + finish uploading (the Remove-media control appears).
    let attached = false;
    for (let i = 0; i < 25 && !attached; i++) {
      attached = await this.c.evalFn(this.tab, () =>
        !!document.querySelector('[data-testid="attachments"] img, [aria-label="Remove media"], [data-testid="removeMedia"], [data-testid="tweetPhoto"]')
      ).catch(() => false);
      if (!attached) await sleep(1000);
    }
    if (!attached) return { posted: false, reason: "image_not_attached" };
    await sleep(1500); // let the upload finalize before enabling Post

    if (text && !(await this._insertVerified(text))) return { posted: false, reason: "text_insert_failed" };
    try { await this._waitPostEnabled(); } catch { return { posted: false, reason: "post_button_disabled" }; }
    const pre = await this._toast(); if (pre) return { posted: false, reason: `anti_automation:${pre}` };
    if (dryRun) { this.log("DRY RUN — image attached + text verified, not posting"); await this._discardComposer(); return { posted: false, reason: "dry_run", dryRun: true }; }

    await humanDelay(1500, 3000);
    if (text && !(await this._settleComposer(text))) return { posted: false, reason: "composer_mismatch_preposting" };
    await this._clickPost();
    await sleep(6000);
    const post2 = await this._toast(); if (post2) return { posted: false, reason: `anti_automation:${post2}` };
    const url = text ? await this._confirmFromProfile(text) : null;
    if (url) { this.log(`posted image tweet: ${url}`); return { posted: true, url }; }
    const now = await this.c.tabUrl(this.tab).catch(() => "");
    if (/\/home/.test(now)) { this.log("image tweet probable success (URL uncaptured)"); return { posted: true, url: null }; }
    return { posted: false, reason: "post_unconfirmed" };
  }

  /**
   * Post a tweet WITH a video — same real-browser mechanism as postImage
   * (composer file input via CDP), but with video-sized waits: X uploads AND
   * transcodes before the Post button enables, which can take minutes for a
   * multi-MB clip. `videoPath` = absolute path on the HelmStack host.
   * @returns {Promise<{posted:boolean, url?:string|null, reason?:string, dryRun?:boolean}>}
   */
  async postVideo(text, videoPath, { dryRun = false } = {}) {
    if (!videoPath) return { posted: false, reason: "no_video" };
    await this.gotoHome();
    await humanDelay(1500, 2500);
    try {
      await this.c.pollFn(this.tab, "compose box", () => !!document.querySelector('[data-testid="tweetTextarea_0"]'), { attempts: 15, interval: 1000, tag: "x" });
    } catch { return { posted: false, reason: "compose_box_not_found" }; }
    await this._focusComposer();
    await sleep(600);
    try { await this.c.setFileInput(this.tab, 'input[data-testid="fileInput"]', [videoPath]); }
    catch (e) { return { posted: false, reason: `file_input:${e.message}` }; }

    // Wait for the video to attach (player/remove control appears)…
    let attached = false;
    for (let i = 0; i < 45 && !attached; i++) {
      attached = await this.c.evalFn(this.tab, () =>
        !!document.querySelector('[data-testid="attachments"] video, [data-testid="videoPlayer"], [aria-label="Remove media"], [data-testid="removeMedia"]')
      ).catch(() => false);
      if (!attached) await sleep(2000);
    }
    if (!attached) return { posted: false, reason: "video_not_attached" };

    if (text && !(await this._insertVerified(text))) return { posted: false, reason: "text_insert_failed" };

    // …then for upload + transcode to finish: Post stays disabled until X is
    // ready, so poll it on video timescales (up to ~4 min).
    let enabled = false;
    for (let i = 0; i < 16 && !enabled; i++) {
      enabled = await this.c.evalFn(this.tab, () => {
        const el = document.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]');
        return el != null && el.getAttribute("aria-disabled") !== "true";
      }).catch(() => false);
      if (!enabled) await sleep(15000);
    }
    if (!enabled) return { posted: false, reason: "video_processing_timeout" };

    const pre = await this._toast(); if (pre) return { posted: false, reason: `anti_automation:${pre}` };
    if (dryRun) { this.log("DRY RUN — video attached + text verified, not posting"); await this._discardComposer(); return { posted: false, reason: "dry_run", dryRun: true }; }

    await humanDelay(1500, 3000);
    if (text && !(await this._settleComposer(text))) return { posted: false, reason: "composer_mismatch_preposting" };
    await this._clickPost();
    await sleep(10000); // video tweets take longer to land
    const post2 = await this._toast(); if (post2) return { posted: false, reason: `anti_automation:${post2}` };
    const url = text ? await this._confirmFromProfile(text) : null;
    if (url) { this.log(`posted video tweet: ${url}`); return { posted: true, url }; }
    const now = await this.c.tabUrl(this.tab).catch(() => "");
    if (/\/home/.test(now)) { this.log("video tweet probable success (URL uncaptured)"); return { posted: true, url: null }; }
    return { posted: false, reason: "post_unconfirmed" };
  }

  /** UI-composer fallback for post() — used only when the API path is unavailable. */
  async _postViaComposer(text, { dryRun = false } = {}) {
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
    if (!(await this._settleComposer(text))) return { posted: false, reason: "composer_mismatch_preposting" };
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
   * Quote-tweet a source post with commentary. Prefers the CreateTweet API with
   * `attachment_url` (no composer → none of its duplication failure modes);
   * falls back to the retweet-menu composer flow if the API is unavailable.
   * X_POST_VIA_API=0 forces the composer. Either way the source page is loaded
   * first so the mentions guard sees the real tweet.
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
    if (process.env.X_POST_VIA_API !== "0") {
      const api = await this.postViaApi(text, { dryRun, attachmentUrl: sourceUrl });
      if (api.posted || api.dryRun) return api;
      this.log(`API quote unavailable (${api.reason}) — falling back to composer`);
    }
    return this._quoteViaComposer(text, { dryRun });
  }

  /** UI-composer fallback for quote() — assumes the source permalink is already loaded. */
  async _quoteViaComposer(text, { dryRun = false } = {}) {
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
    if (!(await this._settleComposer(text))) return { posted: false, reason: "composer_mismatch_preposting" };
    await this._clickPost();
    await sleep(5000);
    const url = await this._confirmFromProfile(text);
    if (url) { this.log(`quoted: ${url}`); return { posted: true, url }; }
    return { posted: false, reason: "post_unconfirmed" };
  }

  /**
   * Reply to a tweet. Prefers the CreateTweet API with `reply.in_reply_to_tweet_id`
   * (no composer → immune to the wedged-tab insert failures). Falls back to the
   * composer flow: if the compose/insert sequence fails there (a wedged tab kills
   * CDP input even when the URL check passes — e.g. after idling through slow
   * LLM work), the tab is recycled and the sequence retried once.
   * X_POST_VIA_API=0 forces the composer.
   * @param {string} tweetUrl  the target status URL
   */
  async reply(tweetUrl, text, { dryRun = false } = {}) {
    const replyToTweetId = (String(tweetUrl).match(/\/status\/(\d+)/) || [])[1];
    if (replyToTweetId && process.env.X_POST_VIA_API !== "0") {
      const api = await this.postViaApi(text, { dryRun, replyToTweetId });
      if (api.posted) { this.log(`replied via API: ${api.url || tweetUrl}`); return { ok: true, url: api.url || null }; }
      if (api.dryRun) return { ok: false, reason: "dry_run", dryRun: true };
      this.log(`API reply unavailable (${api.reason}) — falling back to composer`);
    }
    if (!(await this._gotoChecked(tweetUrl))) return { ok: false, reason: "navigation_failed" };
    let res = await this._replyOnPage(tweetUrl, text, { dryRun });
    const retryable = ["reply_button_not_found", "compose_box_not_found", "text_insert_failed", "composer_mismatch_preposting"];
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
    if (!(await this._settleComposer(text))) return { ok: false, reason: "composer_mismatch_preposting" };
    await this._clickPost();
    await sleep(4000);
    const post2 = await this._toast();
    if (post2) return { ok: false, reason: `anti_automation:${post2}` };
    return { ok: true };
  }

  /**
   * Repost (retweet) a tweet via the CreateRetweet GraphQL mutation — the same
   * in-page authed-fetch machinery as CreateTweet. API-only: no composer is
   * involved, so a failure is cheap to retry and there is no UI fallback.
   * Reposting a tweet that is already reposted is treated as success.
   * @param {string} tweetUrl  https://x.com/<user>/status/<id>
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async retweet(tweetUrl, { dryRun = false } = {}) {
    const id = (String(tweetUrl).match(/\/status\/(\d+)/) || [])[1];
    if (!id) return { ok: false, reason: "bad_url" };
    const cur = await this.c.tabUrl(this.tab).catch(() => "");
    if (!/x\.com|twitter\.com/.test(cur)) { if (!(await this._gotoChecked(HOME_URL))) return { ok: false, reason: "nav_failed" }; }
    if (dryRun) {
      const qid = await this._graphqlQueryId("CreateRetweet");
      if (!qid) return { ok: false, reason: "no_queryid" };
      this.log(`DRY RUN — CreateRetweet API ready (qid ${qid.slice(0, 8)}…), not reposting`);
      return { ok: false, reason: "dry_run", dryRun: true };
    }
    const r = await this._graphqlMutation("CreateRetweet", { tweet_id: id, dark_request: false });
    if (r.json?.data?.create_retweet?.retweet_results?.result?.rest_id) {
      this.log(`reposted: ${tweetUrl}`);
      return { ok: true };
    }
    const msg = (r.json?.errors || []).map((e) => e.message).join("; ");
    if (/already retweeted/i.test(msg)) { this.log(`already reposted: ${tweetUrl}`); return { ok: true, reason: "already_retweeted" }; }
    return { ok: false, reason: this._apiReason(r) };
  }

  /**
   * Undo a repost via the DeleteRetweet GraphQL mutation.
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async unretweet(tweetUrl, { dryRun = false } = {}) {
    const id = (String(tweetUrl).match(/\/status\/(\d+)/) || [])[1];
    if (!id) return { ok: false, reason: "bad_url" };
    if (dryRun) { this.log("DRY RUN — not un-reposting"); return { ok: false, reason: "dry_run", dryRun: true }; }
    const r = await this._graphqlMutation("DeleteRetweet", { source_tweet_id: id, dark_request: false });
    if (r.json?.data?.unretweet?.source_tweet_results?.result?.rest_id) {
      this.log(`un-reposted: ${tweetUrl}`);
      return { ok: true };
    }
    return { ok: false, reason: this._apiReason(r) };
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
      const u = r.url || (await this._confirmFromProfile(tweets[i]).catch(() => null));
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
    if (!(await this._gotoChecked(`https://x.com/${this.handle}`))) return null;
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
   * and a Publish button. dryRun inserts + verifies both fields, then clears
   * them and stops before the Publish click (the house dry-run semantics); an
   * empty "Untitled" draft may remain in the drafts list.
   *
   * Title and body are ASCII-normalized (toComposerSafe) and the body is
   * inserted line-by-line with real Enter keypresses — Input.insertText drops
   * a payload containing "\n" or "scheme://" ENTIRELY (same quirks as the
   * tweet composer), so a raw chunked insert silently loses whole paragraphs.
   * Both fields are verified before Publish; on a verify miss nothing is
   * published (the draft stays in x.com/compose/articles for inspection).
   * Returns { ok, url } (url best-effort from the profile).
   */
  async postArticle({ title, body }, { dryRun = false } = {}) {
    title = toComposerSafe(title);
    body = toComposerSafe(body);
    if (!body) return { ok: false, reason: "empty_body" };
    if (!(await this._gotoChecked("https://x.com/compose/articles"))) return { ok: false, reason: "navigation_failed" };
    await sleep(4000);

    // HelmStack tabs are HIDDEN WebContentsViews: requestAnimationFrame and
    // IntersectionObserver never fire there, and the article editor's mount
    // chain depends on them — the /edit/<id> page spins forever (verified
    // 2026-07-18; every other X surface renders fine hidden). Shim them to
    // timer-based fallbacks BEFORE clicking Write; the shims survive the SPA
    // route into the editor (they'd be wiped by a full navigation).
    await this.c.evalFn(this.tab, () => {
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
      window.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1);
      window.cancelIdleCallback = (id) => clearTimeout(id);
      window.IntersectionObserver = class {
        constructor(cb) { this.cb = cb; }
        observe(el) {
          const r = el.getBoundingClientRect();
          setTimeout(() => this.cb([{ isIntersecting: true, target: el, intersectionRatio: 1, boundingClientRect: r, intersectionRect: r, rootBounds: null, time: performance.now() }], this), 1);
        }
        unobserve() {}
        disconnect() {}
        takeRecords() { return []; }
      };
      try {
        Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
        Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
        document.hasFocus = () => true;
        document.dispatchEvent(new Event("visibilitychange"));
      } catch {}
      return true;
    }).catch(() => {});

    // Open a new article draft: empty-state "Write" button, or the top "create".
    await this.c.evalFn(this.tab, () => {
      const b = document.querySelector("[data-testid=empty_state_button_text]") ||
        Array.from(document.querySelectorAll("button,[role=button]")).find((e) => /^write$|create/i.test((e.innerText || e.getAttribute("aria-label") || "").trim()));
      if (b) (b.closest("button,[role=button]") || b).click();
    });
    // Wait for the editor route AND its fields. The Draft.js editor chunk +
    // draft fetch are SLOW (15-30s of spinners is normal) — poll generously.
    try {
      await this.c.pollFn(this.tab, "article editor", () =>
        /\/compose\/articles\/edit\//.test(location.href) &&
        !!(document.querySelector('[data-testid="composer"]') || document.querySelector('textarea[placeholder*="title" i]')),
        { attempts: 30, interval: 2000, tag: "x" });
    } catch { return { ok: false, reason: "editor_not_found" }; }

    // One page-side helper for both fields (observed 2026-07-18): title is a
    // bare <textarea placeholder="Add a title"> (no aria-label/testid); body is
    // the Draft.js contenteditable div[data-testid="composer"].
    const fieldOp = (which, op) => this.c.evalFn(this.tab, (a) => {
      const findTitle = () =>
        document.querySelector('textarea[placeholder*="title" i], input[aria-label*="Title" i], textarea[aria-label*="Title" i], [data-testid*="itle" i]');
      const findBody = () =>
        document.querySelector('[data-testid="composer"], [aria-label="Body"], [contenteditable="true"][aria-label*="composer" i]') ||
        Array.from(document.querySelectorAll('[contenteditable="true"]')).pop();
      const el = a.which === "title" ? findTitle() : findBody();
      if (!el) return null;
      if (a.op === "rect") {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return JSON.stringify({ x: Math.round(r.x + Math.min(r.width / 2, 200)), y: Math.round(r.y + Math.min(r.height / 2, 20)) });
      }
      if (a.op === "focus") { el.focus(); return "true"; }
      if (a.op === "read") return "value" in el ? String(el.value) : (el.innerText || "");
      if (a.op === "clear") {
        if ("value" in el) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
          setter.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
        return "true";
      }
      return null;
    }, { which, op });

    // element.focus() alone doesn't reliably move CDP input focus (same as the
    // tweet composer) — click the field's bounding box first.
    const focusField = async (which) => {
      const raw = await fieldOp(which, "rect").catch(() => null);
      let pt = null;
      try { pt = JSON.parse(raw); } catch {}
      if (pt) await this.c.clickAt(this.tab, pt.x, pt.y).catch(() => {});
      return !!(await fieldOp(which, "focus"));
    };

    // Insert one logical line, split at URL scheme boundaries ("scheme://"
    // payloads are dropped whole), with the End-key flush after each piece.
    const insertLine = async (line) => {
      const pieces = line.split(/(\s?https?:)(?=\/\/)/).filter(Boolean);
      for (const piece of pieces) {
        await this.c.insertText(this.tab, piece);
        await sleep(250);
        await this.c.pressKey(this.tab, { key: "End", code: "End", keyCode: 35 }).catch(() => {});
        await sleep(150);
      }
    };

    // Title: insert + verify, one clear-and-retry.
    if (title) {
      let okTitle = false;
      for (let t = 0; t < 2 && !okTitle; t++) {
        if (!(await focusField("title"))) return { ok: false, reason: "title_field_not_found" };
        await sleep(300);
        await insertLine(title.replace(/\n+/g, " "));
        await sleep(700);
        okTitle = norm(await fieldOp("title", "read").catch(() => "")) === norm(title.replace(/\n+/g, " "));
        if (!okTitle) { this.log(`article title verify miss ${t + 1}/2`); await fieldOp("title", "clear").catch(() => {}); await sleep(400); }
      }
      if (!okTitle) return { ok: false, reason: "title_verify_failed" };
    }

    // Body: line-by-line with real Enter keypresses, verify the full text,
    // one clear-and-retry. Never publish an unverified body.
    let okBody = false;
    for (let t = 0; t < 2 && !okBody; t++) {
      if (!(await focusField("body"))) return { ok: false, reason: "body_field_not_found" };
      await sleep(300);
      const lines = body.split("\n");
      for (let li = 0; li < lines.length; li++) {
        if (lines[li]) await insertLine(lines[li]);
        if (li < lines.length - 1) {
          await this.c.pressKey(this.tab, { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }).catch(() => {});
          await sleep(150);
        }
      }
      await sleep(1500);
      const got = norm(await fieldOp("body", "read").catch(() => ""));
      okBody = got === norm(body);
      if (!okBody) {
        this.log(`article body verify miss ${t + 1}/2 (${got.length}/${norm(body).length} chars)`);
        await fieldOp("body", "clear").catch(() => {});
        await sleep(600);
      }
    }
    if (!okBody) {
      this.log("article body unverified — NOT publishing (draft left in /compose/articles)");
      return { ok: false, reason: "body_verify_failed" };
    }
    await sleep(1200);

    if (dryRun) {
      this.log("DRY RUN — title + body inserted and verified; clearing draft, not publishing");
      await fieldOp("title", "clear").catch(() => {});
      await fieldOp("body", "clear").catch(() => {});
      await sleep(1000);
      return { ok: false, reason: "dry_run", dryRun: true };
    }

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
   * The conversation on a tweet permalink in CHRONOLOGICAL order: root/ancestor
   * tweets first, then the focused tweet, then replies below. Callers that need
   * "what came before this tweet" (e.g. mention-reply context) slice around the
   * focused id themselves.
   *
   * X anchors the permalink view on the FOCUSED tweet and lazy-renders the
   * ancestor chain above it, so a flat scrape after page-load sees exactly one
   * article and the thread reads as empty (every mention reply used to log
   * "thread: 1 tweet in view"). We scroll UP until no new tweets appear,
   * merging by id across scrapes (virtualization can drop articles out of the
   * DOM between passes) and sorting by timestamp, which equals conversation
   * order within a reply chain.
   */
  async scrapeConversation(tweetUrl, { limit = 6 } = {}) {
    if (!(await this._gotoChecked(tweetUrl))) return [];
    await sleep(2000);
    const focusedId = (String(tweetUrl).match(/\/status\/(\d+)/) || [])[1] || null;
    const seen = new Map();
    const grab = async () => {
      for (const a of await this._scrapeArticles(limit + 6)) {
        if (a.id && !seen.has(a.id)) seen.set(a.id, a);
      }
    };
    await grab();
    let dry = 0;
    for (let i = 0; i < 5 && dry < 2; i++) {
      const before = seen.size;
      await this.c.evaluate(this.tab, "window.scrollBy(0, -1400)").catch(() => {});
      await sleep(1100);
      await grab();
      dry = seen.size === before ? dry + 1 : 0;
    }
    const all = Array.from(seen.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (all.length <= limit) return all;
    // Trim to `limit` but never drop the focused tweet: keep the window of
    // ancestors ending at the focused tweet, then fill with replies below.
    const fi = focusedId ? all.findIndex((a) => a.id === focusedId) : -1;
    if (fi < 0) return all.slice(0, limit);
    const start = Math.max(0, fi - (limit - 1));
    return all.slice(start, start + limit);
  }

  /** Top replies under a tweet permalink (drops the root tweet). */
  async scrapeThreadReplies(tweetUrl, { limit = 10 } = {}) {
    if (!(await this._gotoChecked(tweetUrl))) return [];
    await sleep(1500);
    const all = await this._scrapeArticles(limit + 3);
    return all.slice(1); // caller filters/sorts/slices
  }

  /**
   * Scrape one tweet's own engagement by permalink — the focused tweet's action
   * bar exposes aria-labels like "N replies", "N reposts", "N likes". Returns a
   * {reactions, comments} shape matching the amplify learn-loop (reactions=likes,
   * comments=replies) so a quote tweet's earned engagement can be measured.
   * Best-effort; zeros on miss.
   * @returns {Promise<{reactions:number, comments:number, reposts:number}>}
   */
  async scrapeTweetEngagement(tweetUrl) {
    if (!(await this._gotoChecked(tweetUrl))) return { reactions: 0, comments: 0, reposts: 0 };
    await sleep(2500);
    const id = (String(tweetUrl).match(/\/status\/(\d+)/) || [])[1] || "";
    const raw = await this.c.evalFn(this.tab, (sid) => {
      const num = (s) => { if (s == null) return null; const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMB]?)/i); if (!m) return null; let n = parseFloat(m[1]); const u = (m[2] || "").toUpperCase(); if (u === "K") n *= 1e3; else if (u === "M") n *= 1e6; else if (u === "B") n *= 1e9; return Math.round(n); };
      const arts = Array.from(document.querySelectorAll("article"));
      const art = (sid && arts.find((a) => a.querySelector(`a[href*="/status/${sid}"]`))) || arts[0];
      if (!art) return JSON.stringify({});
      // X's action bar exposes ONE combined aria-label, e.g.
      // "12 replies, 34 reposts, 560 likes, 8 bookmarks, 90000 views".
      const group = art.querySelector('[role="group"][aria-label]');
      const label = group ? group.getAttribute("aria-label") || "" : "";
      const pick = (re) => { const m = label.match(re); return m ? m[1] : null; };
      return JSON.stringify({
        likes: num(pick(/([\d,.]+\s*[KMB]?)\s+like/i)),
        replies: num(pick(/([\d,.]+\s*[KMB]?)\s+repl/i)),
        reposts: num(pick(/([\d,.]+\s*[KMB]?)\s+repost/i)),
      });
    }, id).catch(() => "{}");
    let m = {}; try { m = JSON.parse(raw || "{}"); } catch {}
    return { reactions: m.likes || 0, comments: m.replies || 0, reposts: m.reposts || 0 };
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

  /**
   * Live X search — recent posts matching a query. `mode`: "live" (latest, the
   * default — best for current sentiment) or "top". Scrolls to gather up to
   * `limit`. Reuses the wedge-checked nav + the rich article extractor.
   */
  async searchX(query, { limit = 15, mode = "live", scrolls = 2 } = {}) {
    const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${mode === "top" ? "top" : "live"}`;
    if (!(await this._gotoChecked(url))) return [];
    await sleep(2000);
    const now = await this.c.tabUrl(this.tab).catch(() => "");
    if (now && !/\/search/.test(now)) return [];   // bounced (login wall / redirect)
    const seen = new Map();
    for (let i = 0; i <= scrolls; i++) {
      for (const p of await this._scrapeArticles(limit)) if (p.id && !seen.has(p.id)) seen.set(p.id, p);
      if (seen.size >= limit) break;
      await this.c.evaluate(this.tab, "window.scrollBy(0, window.innerHeight*1.5)").catch(() => {});
      await sleep(1500);
    }
    return Array.from(seen.values()).slice(0, limit);
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
