"use strict";
/**
 * helmstack-social/src/gemini.js — Gemini web-app engine (gemini.google.com).
 *
 * Drives the logged-in Gemini session in the HelmStack browser the same way the
 * X/LinkedIn engines drive theirs. Built for media generation on the account's
 * app entitlements (no API key, no Vertex):
 *
 *   const g = new Gemini(client);
 *   const img = await g.generateImage("pixel art of ...");   // -> { buffer, width, height } | null
 *   const vid = await g.generateVideo("a short clip of ..."); // EXPERIMENTAL -> { buffer, mime } | null
 *
 * Mechanics (validated interactively 2026-07-20):
 *   - each generation starts a fresh chat (navigate to /app) so no context bleeds
 *   - every run DELETES its own chat when it finishes (see cleanup note below)
 *   - prompt goes into the rich-textarea contenteditable via execCommand
 *   - generated images render as blob: <img>; blob refetch is blocked, so bytes
 *     are extracted by drawing the <img> to a canvas -> toDataURL (PNG)
 *   - a null return always carries a logged reason (quota text, sign-in wall,
 *     timeout) — callers ship without media rather than fail
 *
 * NOTE on accounts: this uses whatever Google account is signed in inside the
 * HelmStack profile (Sebastian's own account, free tier as of 2026-07 — image
 * generation works with daily limits; Veo video generally needs an AI Pro
 * entitlement on that account, e.g. via Google One family sharing).
 *
 * NOTE on cleanup (added 2026-08-10): that account is a HUMAN's account, and its
 * chat history is shared with the human's own conversations. Every ask/generate
 * used to leave a saved chat behind, so a few hundred fact-checks buried the
 * owner's real chats. Each call now deletes the conversation it created once the
 * answer/bytes are in hand — set GEMINI_KEEP_CHATS=1 (or `new Gemini(client,
 * { autoDelete: false })`) to keep them while debugging. Deletion targets the
 * conversation open in THIS tab by id; it never matches on titles, so a human
 * chat can't be caught by it. For the existing backlog see purgeChats().
 */

const GEMINI_URL = "https://gemini.google.com/app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Gemini {
  /**
   * @param {import('./client').HelmStackClient} client
   * @param {object} [opts]
   * @param {number} [opts.accountIndex]  Google multi-account index to pin to
   *   (default env GEMINI_ACCOUNT_INDEX or 0). The browser can hold several
   *   Google sessions; /u/N/ addressing keeps media generation on a specific
   *   one (e.g. the AI Pro account) while everything else stays on u/0.
   * @param {boolean} [opts.autoDelete]  Delete each chat this engine creates once
   *   the call is done (default true; GEMINI_KEEP_CHATS=1 turns it off).
   */
  constructor(client, { accountIndex, autoDelete } = {}) {
    this.client = client;
    this.tabId = null;
    const idx = accountIndex !== undefined ? accountIndex : Number(process.env.GEMINI_ACCOUNT_INDEX || 0);
    this.accountIndex = Number.isFinite(idx) && idx > 0 ? idx : 0;
    this.autoDelete = autoDelete !== undefined ? autoDelete : process.env.GEMINI_KEEP_CHATS !== "1";
  }

  get url() {
    return this.accountIndex > 0 ? `https://gemini.google.com/u/${this.accountIndex}/app` : GEMINI_URL;
  }

  /**
   * Is this tab ON gemini? Anchored to the ORIGIN, not a substring: Google's
   * anti-abuse interstitial lives at google.com/sorry/index?continue=https://
   * gemini.google.com/... and a loose test adopts that page as a Gemini tab.
   */
  _isGeminiTab(t) {
    return /^https:\/\/gemini\.google\.com\//.test(t.url || "");
  }

  _tabMatches(t) {
    if (!this._isGeminiTab(t)) return false;
    const m = (t.url || "").match(/\/u\/(\d+)\//);
    const tabIdx = m ? Number(m[1]) : 0;
    return tabIdx === this.accountIndex;
  }

  /**
   * Fresh chat tab on the pinned account: reuse a matching tab, else open one.
   *
   * The reuse test falls back to ANY gemini tab when no `/u/<accountIndex>/` one
   * exists, because Google redirects `/u/N/` to the account that is actually
   * signed in — with GEMINI_ACCOUNT_INDEX=1 and only one Google session, every
   * tab lands on `/u/0/`, `_tabMatches` never matched, and each call opened a
   * tab that was never closed (a dozen stale Gemini tabs after a day of
   * fact-checking). The navigate below still targets the pinned URL, so pinning
   * is unchanged — only tab reuse gets more forgiving.
   */
  async ensureTab() {
    const tabs = await this.client.listTabs().catch(() => []);
    const reuse = tabs.find((t) => this._tabMatches(t)) || tabs.find((t) => this._isGeminiTab(t));
    // `client.ensureTab` opens a tab when its predicate matches nothing, which is
    // exactly what we want once both reuse tiers have missed.
    this.tabId = reuse ? reuse.id : await this.client.ensureTab(() => false, this.url);
    // Always reset to a new conversation so prior prompts don't leak in.
    await this.client.request("POST", `/api/tabs/${this.tabId}/navigate`, { url: this.url });
    await sleep(3500);
    // Too many loads in a row and Google answers with its anti-abuse
    // interstitial instead of the app. Record it: signedIn() can't see it (there
    // is no "Sign in" button on that page), so callers used to report a missing
    // editor or an empty history and carry on hammering.
    const landed = await this.client.tabUrl(this.tabId).catch(() => "");
    this.blocked = /google\.com\/sorry/.test(landed);
    if (this.blocked) console.warn("[gemini] Google served its anti-abuse interstitial — the app did not load. A human has to clear it in the browser.");
    await this._dismissDialogs();
    return this.tabId;
  }

  /** Reason string when the app is unreachable, else null. */
  _unavailable() {
    if (this.blocked) return "Google anti-abuse interstitial is up";
    return null;
  }

  async _eval(expression, opts) {
    return this.client.evaluate(this.tabId, expression, opts);
  }

  async _dismissDialogs() {
    await this._eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /got it|no thanks|dismiss/i.test(x.textContent));
      if (b) { b.click(); return 'dismissed'; }
      return 'none';
    })()`).catch(() => {});
  }

  /** Crude sign-in check: a visible prominent "Sign in" button means no session. */
  async signedIn() {
    const r = await this._eval(`(() => {
      const btn = [...document.querySelectorAll('a,button')].find(x => /^\\s*sign in\\s*$/i.test(x.textContent||''));
      return !btn;
    })()`).catch(() => false);
    return !!r;
  }

  /**
   * Attach a local image to the prompt (character reference / image-to-video
   * start frame). Gemini's composer keeps a hidden file input; CDP
   * DOM.setFileInputFiles reaches it without the picker UI.
   */
  async attachImage(filePath) {
    // Surface the upload affordance first (some builds only mount the input
    // after the + menu opens); harmless if the input already exists.
    await this._eval(`(() => {
      const plus = document.querySelector('button[aria-label*="Add" i], button[aria-label*="Upload" i], button[aria-label*="attach" i], uploader button');
      if (plus) plus.click();
      return !!plus;
    })()`).catch(() => {});
    await sleep(800);
    const hasInput = await this._eval(`!!document.querySelector('input[type="file"]')`).catch(() => false);
    if (!hasInput) { console.warn("[gemini] no file input found — continuing without reference image"); return false; }
    try {
      await this.client.setFileInput(this.tabId, 'input[type="file"]', [filePath]);
    } catch (e) {
      console.warn(`[gemini] reference attach failed (${e.message}) — continuing without it`);
      return false;
    }
    // Wait for the upload chip/thumbnail to appear in the composer.
    for (let i = 0; i < 10; i++) {
      await sleep(1200);
      const ready = await this._eval(`(() => {
        const chip = document.querySelector('uploader-file-preview, [data-test-id*="file-preview"], img[src^="blob:"], [class*="attachment"]');
        return !!chip;
      })()`).catch(() => false);
      if (ready) { console.log("[gemini] reference image attached"); return true; }
    }
    console.warn("[gemini] reference upload did not confirm — continuing anyway");
    return false;
  }

  async _typeAndSend(prompt) {
    const typed = await this._eval(`(() => {
      const ed = document.querySelector('rich-textarea [contenteditable="true"], [contenteditable="true"]');
      if (!ed) return 'no-editor';
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      return 'ok';
    })()`);
    if (typed !== "ok") throw new Error(`gemini editor not found (${typed})`);
    await sleep(400);
    const sent = await this._eval(`(() => {
      const send = document.querySelector('button[aria-label*="Send" i], button[aria-label*="Submit" i], .send-button');
      if (!send) return 'no-send';
      send.click(); return 'ok';
    })()`);
    if (sent !== "ok") throw new Error("gemini send button not found");
  }

  /** Last model-response text (for surfacing quota/refusal reasons). */
  async _lastResponseText() {
    const t = await this._eval(
      `(document.querySelector('model-response:last-of-type, message-content:last-of-type')?.textContent || '').slice(0, 300)`
    ).catch(() => "");
    return String(t || "").trim();
  }

  /** Poll an in-page boolean expression until true. Returns whether it went true. */
  async _waitFor(expression, timeoutMs = 8000, interval = 400) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this._eval(expression).catch(() => false)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(interval);
    }
  }

  /** Close any open menu/dialog so the next call starts from a clean composer. */
  async _dismissOverlays() {
    await this._eval(`(() => {
      document.querySelectorAll('.cdk-overlay-backdrop').forEach(b => b.click());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'ok';
    })()`).catch(() => {});
  }

  /**
   * The conversation id in the tab URL (`/app/<id>`), or null when the chat is
   * still unsaved (a fresh `/app` before the first turn completes).
   */
  async currentConversationId() {
    const url = await this.client.tabUrl(this.tabId).catch(() => "");
    const m = String(url || "").match(/\/app\/([0-9a-z]{8,})/i);
    return m ? m[1] : null;
  }

  /**
   * Delete the conversation currently open in this tab: top-bar ⋮ →
   * "Delete" → confirm "Delete chat?". Returns true when Gemini navigated off
   * the conversation (i.e. it is gone).
   *
   * Targets the OPEN conversation only — there is no title/keyword matching
   * anywhere in this path, which is what keeps it off the account owner's own
   * chats. Returns false (never throws) when there is nothing to delete or the
   * UI moved; callers treat cleanup as best-effort.
   */
  async deleteCurrentChat({ timeoutMs = 20_000 } = {}) {
    const convId = await this.currentConversationId();
    if (!convId) return false; // unsaved chat — nothing in history to remove

    try {
      const opened = await this._eval(`(() => {
        const icon = document.querySelector('conversation-actions-icon');
        const btn = icon && (icon.querySelector('button, [role="button"]') || icon.firstElementChild);
        if (!btn) return 'no-trigger';
        btn.click();
        return 'ok';
      })()`);
      if (opened !== "ok") throw new Error(`conversation menu not found (${opened})`);

      if (!(await this._waitFor(`!!document.querySelector('[data-test-id="delete-button"]')`, 5000))) {
        throw new Error("delete item did not appear in the menu");
      }
      await this._eval(`document.querySelector('[data-test-id="delete-button"]').click()`);

      // Confirm dialog: both buttons share a class, so pick by label and never
      // by position — a reordered dialog must miss rather than hit Cancel.
      const CONFIRM = `[...document.querySelectorAll('mat-dialog-container button, [role="dialog"] button')]
        .find(b => /^\\s*delete\\s*$/i.test(b.textContent || ''))`;
      if (!(await this._waitFor(`!!(${CONFIRM})`, 5000))) {
        throw new Error("delete confirmation dialog did not appear");
      }
      await this._eval(`(${CONFIRM}).click()`);

      // Gemini routes back to a blank /app once the chat is gone.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(600);
        const url = await this.client.tabUrl(this.tabId).catch(() => "");
        if (!String(url).includes(convId)) {
          console.log(`[gemini] deleted chat ${convId}`);
          return true;
        }
      }
      throw new Error("chat still open after confirming delete");
    } catch (e) {
      console.warn(`[gemini] could not delete chat ${convId}: ${e.message}`);
      await this._dismissOverlays();
      return false;
    }
  }

  /** Best-effort cleanup of the chat this run created. Never throws. */
  async _cleanup() {
    if (!this.autoDelete) return;
    await this.deleteCurrentChat().catch(() => {});
  }

  /**
   * ask(prompt) — TEXT question/answer through the Gemini web app.
   *
   * The session-based counterpart to the retired Vertex/Gemini API calls: no API
   * key, no per-token billing, just the signed-in browser profile. Used for claim
   * verification, where a frontier model's judgement beats the local 7B brain.
   *
   * Responses STREAM, so there is no single "done" event to await — poll the
   * response text until it stops growing for `settleChecks` consecutive reads,
   * then return it. Returns the answer string, or null (reason logged) so a
   * caller can fall back rather than crash.
   *
   * @param {string} prompt
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=120000]  hard cap on the whole exchange
   * @param {number} [opts.maxChars=8000]     cap on the returned answer
   * @param {number} [opts.settleChecks=3]    identical reads that mean "finished"
   */
  async ask(prompt, { timeoutMs = 120_000, maxChars = 8000, settleChecks = 3 } = {}) {
    await this.ensureTab();
    if (this.blocked) { console.warn(`[gemini] skipping ask — ${this._unavailable()}`); return null; }
    if (!(await this.signedIn())) {
      console.warn("[gemini] no Google session in the HelmStack profile — skipping ask");
      return null;
    }
    // _typeAndSend resolves undefined on success and THROWS on failure.
    try {
      await this._typeAndSend(prompt);
    } catch (e) {
      console.warn(`[gemini] could not submit the prompt: ${e.message}`);
      return null;
    }

    // Read the full last response and wait for it to stop changing.
    // textContent, NOT innerText: while a reply streams, its spans carry
    // class="pending" and are visually hidden, so innerText comes back empty (or
    // just the "Gemini said" screen-reader label) even though the answer is
    // already in the DOM. That label is prefixed to textContent, so strip it.
    const readFull = () => this._eval(
      `(() => {
        const el = document.querySelector('model-response:last-of-type')
               || document.querySelector('message-content:last-of-type')
               || document.querySelector('.markdown');
        let t = (el && el.textContent || '').trim();
        t = t.replace(/^\\s*Gemini\\s+(said|replied)\\s*:?\\s*/i, '');
        return t.slice(0, ${maxChars});
      })()`
    ).catch(() => "");

    const deadline = Date.now() + timeoutMs;
    let last = "", stable = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      const now = String((await readFull()) || "").trim();
      if (now && now === last) {
        if (++stable >= settleChecks) {
          console.log(`[gemini] ask answered (${now.length} chars)`);
          await this._cleanup();
          return now;
        }
      } else {
        stable = 0;
        last = now;
      }
    }
    console.warn(`[gemini] ask timed out after ${Math.round(timeoutMs / 1000)}s${last ? ` — partial: "${last.slice(0, 140)}"` : ""}`);
    await this._cleanup();
    return last || null;
  }

  /**
   * Generate one image. Returns { buffer, width, height } or null (reason logged).
   * @param {string} prompt        image description (style directive included by caller)
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=180000]
   * @param {number} [opts.minWidth=512]  reject icons/thumbnails
   */
  async generateImage(prompt, { timeoutMs = 180_000, minWidth = 512, referenceImagePath = null } = {}) {
    await this.ensureTab();
    if (this.blocked) { console.warn(`[gemini] skipping image — ${this._unavailable()}`); return null; }
    if (!(await this.signedIn())) {
      console.warn("[gemini] no Google session in the HelmStack profile — skipping image");
      return null;
    }

    // Same rule as generateVideo: promise the model only what actually attached.
    const attached = referenceImagePath ? await this.attachImage(referenceImagePath) : false;
    if (referenceImagePath && !attached) console.warn("[gemini] reference image did not attach — generating WITHOUT a character reference");

    const fullPrompt = attached
      ? `Generate an image using the attached image as the exact character reference — same character, same design. ${prompt}`
      : `Generate an image. ${prompt}`;
    await this._typeAndSend(fullPrompt);

    // Generated media lives inside model-response; scoping there keeps a
    // user-bubble attachment (the reference image) from being mistaken for output.
    const FIND_IMG = `[...document.querySelectorAll('model-response img')]
        .find(i => i.src.startsWith('blob:') && i.naturalWidth >= ${minWidth})`;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(4000);
      const found = await this._eval(`(() => {
        const img = ${FIND_IMG};
        return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
      })()`).catch(() => null);
      if (found) {
        // blob: refetch is blocked in this app — canvas is the reliable path.
        const dataUrl = await this._eval(`(() => {
          const img = ${FIND_IMG};
          if (!img) return null;
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          return c.toDataURL('image/png');
        })()`, { timeout: 60_000 });
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,")) {
          const buffer = Buffer.from(dataUrl.split(",")[1], "base64");
          console.log(`[gemini] image generated: ${found.w}x${found.h}, ${buffer.length} bytes`);
          // Bytes are in hand — the chat is now disposable.
          await this._cleanup();
          return { buffer, width: found.w, height: found.h };
        }
      }
    }

    const why = await this._lastResponseText();
    console.warn(`[gemini] no image within ${Math.round(timeoutMs / 1000)}s${why ? ` — last response: "${why.slice(0, 140)}"` : ""}`);
    await this._cleanup();
    return null;
  }

  /**
   * EXPERIMENTAL: generate a short video (Veo via the Gemini app). Requires the
   * signed-in account to have a video entitlement; on a free account this will
   * time out or surface an upsell, and we return null with the reason logged.
   *
   * Returns { buffer, mime } or null. Bytes are pulled through the page in
   * base64 chunks (videos are too big for a single evaluate round-trip).
   */
  async generateVideo(prompt, { timeoutMs = 600_000, referenceImagePath = null } = {}) {
    await this.ensureTab();
    if (this.blocked) { console.warn(`[gemini] skipping video — ${this._unavailable()}`); return null; }
    if (!(await this.signedIn())) {
      console.warn("[gemini] no Google session — skipping video");
      return null;
    }

    // Build the prompt from whether the reference ACTUALLY attached, not from
    // whether one was requested. attachImage returns false when the file input
    // isn't present, and ignoring that sent "use the attached image as the exact
    // character reference" with nothing attached — Gemini then replies "Please
    // upload the image(s) for me to generate the video", which this code used to
    // misreport as "likely no Veo entitlement". Every stance video to date failed
    // this way.
    const attached = referenceImagePath ? await this.attachImage(referenceImagePath) : false;
    if (referenceImagePath && !attached) console.warn("[gemini] reference image did not attach — asking for a video WITHOUT a character reference");
    const fullPrompt = attached
      ? `Create a video using the attached image as the exact character reference — same character, same design. ${prompt}`
      : `Create a video: ${prompt}`;
    await this._typeAndSend(fullPrompt);

    const deadline = Date.now() + timeoutMs;
    let src = null;
    while (Date.now() < deadline && !src) {
      await sleep(10_000);
      src = await this._eval(`(() => {
        const v = document.querySelector('model-response video, video');
        return v && v.src ? v.src : null;
      })()`).catch(() => null);
    }
    if (!src) {
      const why = await this._lastResponseText();
      console.warn(`[gemini] no video produced${why ? ` — last response: "${why.slice(0, 140)}"` : ""} ${/upload|attach|image/i.test(why || "") ? " (Gemini is ASKING FOR AN IMAGE — the reference attach failed, this is not an entitlement problem)" : " (possibly no Veo entitlement on this account)"}`);
      await this._cleanup();
      return null;
    }

    // Veo serves the clip from a signed usercontent.google.com URL that needs
    // the browser's Google cookies (in-page fetch dies on CORS; cookie-less
    // fetch gets an HTML wall). Pull the cookies for that origin from the
    // browser and fetch the bytes Node-side — verified 2026-07-20.
    if (!/^https?:/.test(src)) {
      console.warn(`[gemini] unexpected video src scheme: ${src.slice(0, 40)} — cannot extract`);
      await this._cleanup();
      return null;
    }
    // Cleanup runs only AFTER the bytes are fetched below: the signed
    // usercontent URL is served off the live conversation.
    try {
      const origin = new URL(src).origin;
      const raw = await this.client.getCookies(this.tabId, origin).catch(() => null);
      const list = Array.isArray(raw) ? raw : (raw && raw.cookies) || [];
      const cookieHeader = list.map((k) => `${k.name}=${k.value}`).join("; ");
      const res = await fetch(src, {
        headers: {
          cookie: cookieHeader,
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      });
      const mime = res.headers.get("content-type") || "";
      if (!res.ok || !/video|octet/.test(mime)) {
        console.warn(`[gemini] video fetch got HTTP ${res.status} ${mime} — cookie wall?`);
        await this._cleanup();
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      console.log(`[gemini] video generated: ${(buffer.length / 1048576).toFixed(1)} MB (${mime})`);
      await this._cleanup();
      return { buffer, mime };
    } catch (e) {
      console.warn(`[gemini] video byte extraction failed: ${e.message}`);
      await this._cleanup();
      return null;
    }
  }

  // ── History maintenance ─────────────────────────────────────────────────────

  /**
   * Make sure the conversation list is actually rendered.
   *
   * While the sidenav is collapsed Gemini keeps every `gem-nav-list-item` row
   * mounted but EMPTY — `<gem-nav-list-item data-test-id="conversation">` with
   * nothing but Angular comment anchors inside. So the rows count as present
   * while carrying no link and no title, and a reader that waits on the rows
   * gets 37 chats it can say nothing about. Expand first, then read.
   */
  async _expandSidebar() {
    const HAS_LINKS = `document.querySelectorAll('[data-test-id="conversation"] a[href*="/app/"]').length > 0`;
    if (await this._eval(HAS_LINKS).catch(() => false)) return true;
    await this._eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => /open sidebar|expand|main menu/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return 'none';
      b.click();
      return 'ok';
    })()`).catch(() => {});
    return this._waitFor(HAS_LINKS, 10_000);
  }

  /** `ms` spread by ±`jitter` so a run isn't a metronome. Never below 500ms. */
  _jittered(ms, jitter = 0.4) {
    const spread = ms * jitter;
    return Math.max(500, Math.round(ms - spread + Math.random() * spread * 2));
  }

  /** Absolute URL of a conversation on the pinned account. */
  _convUrl(id) {
    return this.accountIndex > 0
      ? `https://gemini.google.com/u/${this.accountIndex}/app/${id}`
      : `https://gemini.google.com/app/${id}`;
  }

  /**
   * The sidebar conversations as `[{ id, title }]`, newest first. The list is
   * virtualised, so scroll it until the count stops growing (bounded).
   */
  async listChats({ maxScrolls = 40 } = {}) {
    const read = () => this._eval(
      `JSON.stringify([...document.querySelectorAll('[data-test-id="conversation"] a[href*="/app/"]')].map(a => ({
        id: (a.getAttribute('href') || '').split('/app/')[1] || '',
        title: a.getAttribute('aria-label') || (a.textContent || '').trim(),
      })).filter(c => c.id))`
    ).catch(() => "[]");
    // The sidebar mounts a beat after navigation, and stays contentless while
    // collapsed. Wait for the LINKS (not the rows) and open the nav if needed.
    await this._waitFor(`document.querySelectorAll('[data-test-id="conversation"]').length > 0`, 20_000);
    await this._expandSidebar();
    let chats = JSON.parse((await read()) || "[]");
    for (let i = 0; i < maxScrolls; i++) {
      await this._eval(`(() => {
        const s = document.querySelector('conversations-list infinite-scroller, infinite-scroller, conversations-list');
        if (s) s.scrollTop = s.scrollHeight;
        return 'ok';
      })()`).catch(() => {});
      await sleep(900);
      const next = JSON.parse((await read()) || "[]");
      if (next.length <= chats.length) break;
      chats = next;
    }
    return chats;
  }

  /**
   * The first thing the human/agent typed in the open conversation. This is the
   * fingerprint purgeChats() matches on — the prompts this engine sends are
   * fixed strings from this file, so an exact prefix match identifies Sebastian's
   * chats with no risk of catching one of the account owner's.
   */
  /**
   * `{ turns, first }` for the open conversation — how many user bubbles are
   * rendered, and the text of the topmost one.
   *
   * `turns` matters as much as the text. Gemini renders long conversations
   * lazily, so the topmost bubble is whichever turn happens to be loaded, not
   * necessarily the opening one (the same human chat reported two different
   * "first" prompts across two runs). Every chat this engine creates is a fresh
   * single-turn one, so requiring exactly one rendered turn alongside the prompt
   * match keeps a long human chat out of range even if some bubble of theirs
   * were to read like an agent prompt.
   */
  async conversationShape({ maxChars = 400, expectId = null } = {}) {
    const raw = await this._eval(
      `JSON.stringify((() => {
        const qs = [...document.querySelectorAll('user-query')];
        let t = (qs[0]?.textContent || '').trim().replace(/^\\s*You\\s+said\\s*:?\\s*/i, '');
        return {
          here: ${expectId ? `location.href.indexOf(${JSON.stringify(expectId)}) >= 0` : "true"},
          turns: qs.length,
          first: t.slice(0, ${maxChars}),
        };
      })())`
    ).catch(() => null);
    try { return JSON.parse(raw); } catch { return { here: false, turns: 0, first: "" }; }
  }

  /**
   * Poll `conversationShape` until the tab is on `id` AND a turn has text.
   *
   * One read, not two. Waiting on a "has text" probe and then reading the text
   * in a second call let the page move between them: the probe passed against
   * the outgoing chat, the read landed on the incoming one before it filled, and
   * the prompt came back empty — which reads as "not an agent chat" and quietly
   * skips it. Returns the shape, or null on timeout.
   */
  async _awaitConversation(id, timeoutMs = 20_000, interval = 700) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const shape = await this.conversationShape({ expectId: id });
      if (shape.here && shape.turns > 0 && shape.first) return shape;
      if (Date.now() >= deadline) return null;
      await sleep(interval);
    }
  }

  async firstPromptText({ maxChars = 400 } = {}) {
    const t = await this._eval(
      `(() => {
        let t = (document.querySelector('user-query, user-query-content')?.textContent || '').trim();
        // Same screen-reader label trick as model responses ("Gemini said …"):
        // the user bubble is prefixed with "You said", which would push every
        // prompt past an anchored fingerprint.
        t = t.replace(/^\\s*You\\s+said\\s*:?\\s*/i, '');
        return t.slice(0, ${maxChars});
      })()`
    ).catch(() => "");
    return String(t || "").trim();
  }

  /**
   * Prompt prefixes this engine emits. Anything in Gemini's history opening with
   * one of these was written by Sebastian, not by the person who owns the
   * account. Keep in sync with the prompts built above / by callers.
   */
  static get AGENT_PROMPT_PATTERNS() {
    return [
      /^You are a fact-checker\. Using ONLY the search results below/i, // web_search.js verify
      /^Generate an image(\.| using the attached image)/i,              // generateImage
      /^Create a video(:| using the attached image)/i,                  // generateVideo
    ];
  }

  /**
   * Clear the backlog this engine left behind before it learned to clean up.
   *
   * Walks the sidebar, opens each conversation, and deletes it ONLY when its
   * first prompt matches `patterns` (default: AGENT_PROMPT_PATTERNS). Titles are
   * never used to decide — Gemini titles are model-written and a human chat can
   * easily read like a fact-check. Defaults to a dry run.
   *
   * @param {object} [opts]
   * @param {RegExp[]} [opts.patterns]
   * @param {boolean}  [opts.dryRun=true]
   * @param {number}   [opts.max=Infinity]      stop after this many deletions
   * @param {number}   [opts.maxScan=Infinity]  stop after opening this many chats
   * @param {number}   [opts.pauseMs=9000]      base delay between chats
   * @param {number}   [opts.jitter=0.4]        ± fraction applied to every delay
   * @param {number}   [opts.restEvery=8]       take a long rest after this many chats
   * @param {number}   [opts.restMs=120000]     length of that rest
   * @param {function} [opts.onChat]            ({ title, prompt, match, deleted }) => void
   * @param {function} [opts.onRest]            (ms, stats) => void
   * @returns {Promise<{scanned, matched, deleted, kept, acted, failures}>}
   *   `acted` lists the agent chats deleted (or, in a dry run, that would be) as
   *   `{id, title, prompt}`; `failures` lists `{id, title, reason}`. Neither
   *   records the chats left alone — those are the account owner's, and a report
   *   of what this tool DID has no business carrying their titles around.
   */
  async purgeChats({
    patterns, dryRun = true, max = Infinity, maxScan = Infinity,
    pauseMs = 9000, jitter = 0.4, restEvery = 8, restMs = 120_000,
    ownTab = true, onChat, onRest,
  } = {}) {
    const pats = patterns || Gemini.AGENT_PROMPT_PATTERNS;
    // A purge takes 12-15 minutes, and the live agent fact-checks throughout it.
    // Sharing the engine's usual tab means both sides navigate it: a run where
    // the agent was busy lost 12 of 37 chats to "did not load", because the tab
    // kept getting steered to someone else's conversation mid-read. Take a tab of
    // our own and give it back at the end.
    const ownedTab = ownTab ? await this._openOwnTab() : null;
    if (!ownedTab) await this.ensureTab();
    // The CLI is interactive: stop hard rather than report an empty history.
    if (this.blocked) throw new Error("Google anti-abuse interstitial is up — clear it by hand in the browser, then re-run (a larger --pause-ms helps).");
    if (!(await this.signedIn())) {
      console.warn("[gemini] no Google session in the HelmStack profile — skipping purge");
      return { scanned: 0, matched: 0, deleted: 0, kept: 0 };
    }

    const stats = { scanned: 0, matched: 0, deleted: 0, kept: 0, acted: [], failures: [] };
    try {
    const chats = await this.listChats();
    if (!chats.length) {
      // Distinguish "no history" from "the list rendered but ids didn't" —
      // returning zeros for both made a broken selector look like a clean run.
      const items = await this._eval(`document.querySelectorAll('[data-test-id="conversation"]').length`).catch(() => 0);
      if (Number(items) > 0) throw new Error(`sidebar shows ${items} chats but no /app/<id> links could be read — Gemini's markup changed`);
      console.warn("[gemini] no conversations in the sidebar — nothing to purge");
      return stats;
    }

    for (const { id, title } of chats) {
      if (stats.deleted >= max || stats.scanned >= maxScan) break;

      // Cadence. One full page load per chat, back to back, is what tripped
      // Google's interstitial the first time: the load rate, not the identity of
      // the client, is the signal. So the run throttles ITSELF — a jittered gap
      // between chats and a long rest every `restEvery` — instead of trying to
      // look like something it isn't. Everything here is a delay; nothing spoofs
      // a fingerprint, a user agent, or an input event.
      if (stats.scanned) {
        if (restEvery && stats.scanned % restEvery === 0) {
          const rest = this._jittered(restMs, jitter);
          if (onRest) onRest(rest, { ...stats });
          else console.log(`[gemini] resting ${Math.round(rest / 1000)}s after ${stats.scanned} chats`);
          await sleep(rest);
        } else {
          await sleep(this._jittered(pauseMs, jitter));
        }
      }

      // Full navigation, NOT a sidebar click: in-app routing leaves the previous
      // conversation's <user-query> nodes mounted and appends the new ones, so
      // "first prompt" would read whichever chat was opened first. A real load
      // remounts the app, making the first bubble unambiguously this chat's.
      // One retry: a chat that didn't render in time is usually a transient
      // slow load, and failing it outright leaves an agent chat behind.
      let shape = null;
      for (let attempt = 1; attempt <= 2 && !shape; attempt++) {
        const navErr = await this.client.navigate(this.tabId, this._convUrl(id)).then(() => null, (e) => e.message);
        if (navErr) console.warn(`[gemini] navigate to ${id} failed (${navErr})`);
        shape = await this._awaitConversation(id);
        if (!shape && attempt === 1) await sleep(this._jittered(4000, jitter));
      }
      if (!shape) {
        // Rapid page loads can trip Google's anti-abuse interstitial. That is a
        // stop sign, not an obstacle: bail out and let a human deal with it,
        // rather than grinding through the rest of the list against a wall.
        const landed = await this.client.tabUrl(this.tabId).catch(() => "");
        if (/google\.com\/sorry/.test(landed)) {
          throw new Error("Google served its anti-abuse interstitial — purge stopped. Clear it by hand in the browser and re-run later (a larger --pause-ms helps).");
        }
        console.warn(`[gemini] could not open chat ${id} (${title}) — leaving it alone`);
        // Not counted as kept: it was never examined, so it belongs in the
        // failure list only. Folding it into `kept` made "left alone" exceed
        // "scanned" in the summary.
        stats.failures.push({ id, title, reason: "chat did not load" });
        continue;
      }

      const { turns, first: prompt } = shape;
      // Both conditions, always: this engine only ever leaves single-turn chats.
      const match = turns === 1 && pats.some((re) => re.test(prompt));
      stats.scanned++;
      let deleted = false;
      if (match) {
        stats.matched++;
        if (dryRun) {
          stats.kept++;
        } else {
          deleted = await this.deleteCurrentChat();
          if (deleted) {
            stats.deleted++;
          } else {
            stats.failures.push({ id, title, reason: "delete did not confirm" });
            stats.kept++;
          }
        }
        // Recorded whether or not it went: in a dry run this IS the plan, and
        // after a real run it is the only record that the chat ever existed.
        stats.acted.push({ id, title, prompt: prompt.slice(0, 120), deleted });
      } else {
        stats.kept++;
      }
      if (onChat) onChat({ id, title, prompt, match, deleted });
    }
    return stats;
    } finally {
      if (ownedTab) await this.client.closeTab(ownedTab).catch(() => {});
    }
  }

  /**
   * Open a tab this engine owns for the duration of one long job, so a
   * concurrent agent run navigating the shared tab can't yank the page out from
   * under it. Returns the tab id (also set as `this.tabId`), or null if the tab
   * could not be opened — callers fall back to ensureTab().
   */
  async _openOwnTab() {
    try {
      const before = new Set((await this.client.listTabs()).map((t) => t.id));
      const after = await this.client.openTab(this.url);
      const created = after.find((t) => !before.has(t.id));
      if (!created) return null;
      this.tabId = created.id;
      await sleep(3500);
      const landed = await this.client.tabUrl(this.tabId).catch(() => "");
      this.blocked = /google\.com\/sorry/.test(landed);
      if (this.blocked) console.warn("[gemini] Google served its anti-abuse interstitial — the app did not load. A human has to clear it in the browser.");
      await this._dismissDialogs();
      return this.tabId;
    } catch (e) {
      console.warn(`[gemini] could not open a dedicated tab (${e.message}) — sharing the usual one`);
      return null;
    }
  }
}

module.exports = { Gemini, GEMINI_URL };
