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
   */
  constructor(client, { accountIndex } = {}) {
    this.client = client;
    this.tabId = null;
    const idx = accountIndex !== undefined ? accountIndex : Number(process.env.GEMINI_ACCOUNT_INDEX || 0);
    this.accountIndex = Number.isFinite(idx) && idx > 0 ? idx : 0;
  }

  get url() {
    return this.accountIndex > 0 ? `https://gemini.google.com/u/${this.accountIndex}/app` : GEMINI_URL;
  }

  _tabMatches(t) {
    const u = t.url || "";
    if (!/gemini\.google\.com/.test(u)) return false;
    const m = u.match(/\/u\/(\d+)\//);
    const tabIdx = m ? Number(m[1]) : 0;
    return tabIdx === this.accountIndex;
  }

  /** Fresh chat tab on the pinned account: reuse a matching tab, else open one. */
  async ensureTab() {
    this.tabId = await this.client.ensureTab((t) => this._tabMatches(t), this.url);
    // Always reset to a new conversation so prior prompts don't leak in.
    await this.client.request("POST", `/api/tabs/${this.tabId}/navigate`, { url: this.url });
    await sleep(3500);
    await this._dismissDialogs();
    return this.tabId;
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
          return now;
        }
      } else {
        stable = 0;
        last = now;
      }
    }
    console.warn(`[gemini] ask timed out after ${Math.round(timeoutMs / 1000)}s${last ? ` — partial: "${last.slice(0, 140)}"` : ""}`);
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
    if (!(await this.signedIn())) {
      console.warn("[gemini] no Google session in the HelmStack profile — skipping image");
      return null;
    }

    if (referenceImagePath) await this.attachImage(referenceImagePath);

    const fullPrompt = referenceImagePath
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
          return { buffer, width: found.w, height: found.h };
        }
      }
    }

    const why = await this._lastResponseText();
    console.warn(`[gemini] no image within ${Math.round(timeoutMs / 1000)}s${why ? ` — last response: "${why.slice(0, 140)}"` : ""}`);
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
    if (!(await this.signedIn())) {
      console.warn("[gemini] no Google session — skipping video");
      return null;
    }

    if (referenceImagePath) await this.attachImage(referenceImagePath);
    const fullPrompt = referenceImagePath
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
      console.warn(`[gemini] no video produced${why ? ` — last response: "${why.slice(0, 140)}"` : ""} (likely no Veo entitlement on this account)`);
      return null;
    }

    // Veo serves the clip from a signed usercontent.google.com URL that needs
    // the browser's Google cookies (in-page fetch dies on CORS; cookie-less
    // fetch gets an HTML wall). Pull the cookies for that origin from the
    // browser and fetch the bytes Node-side — verified 2026-07-20.
    if (!/^https?:/.test(src)) {
      console.warn(`[gemini] unexpected video src scheme: ${src.slice(0, 40)} — cannot extract`);
      return null;
    }
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
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      console.log(`[gemini] video generated: ${(buffer.length / 1048576).toFixed(1)} MB (${mime})`);
      return { buffer, mime };
    } catch (e) {
      console.warn(`[gemini] video byte extraction failed: ${e.message}`);
      return null;
    }
  }
}

module.exports = { Gemini, GEMINI_URL };
