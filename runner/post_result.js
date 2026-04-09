"use strict";

const fs = require("fs");

const HANDLE = "SebHunts_AI";
const STATUS_URL_RE = new RegExp(`^https://x\\.com/${HANDLE}/status/\\d+(?:\\?.*)?$`, "i");

function isConfirmedStatusUrl(value) {
  const v = String(value || "").trim();
  return STATUS_URL_RE.test(v);
}

function clearFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

function writeResult(file, url) {
  if (!isConfirmedStatusUrl(url)) {
    throw new Error(`refusing to write unconfirmed status URL: ${url || "<empty>"}`);
  }
  fs.writeFileSync(file, `${String(url).trim()}\n`);
}

function writeAttempt(file, payload) {
  const body = {
    at: new Date().toISOString(),
    ...payload,
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
}

async function captureComposeDiagnostics(page, {
  composeSelector = '[data-testid="tweetTextarea_0"]',
  postButtonSelector = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
} = {}) {
  try {
    return await page.evaluate(({ composeSelector, postButtonSelector }) => {
      const squash = (value, limit = 280) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
      const textList = (selector, limit = 6) => Array.from(document.querySelectorAll(selector))
        .map(el => squash(el.innerText || el.textContent || ""))
        .filter(Boolean)
        .slice(0, limit);

      const compose = document.querySelector(composeSelector);
      const button = document.querySelector(postButtonSelector);
      const dialog = document.querySelector('[role="dialog"]');

      return {
        page_title: document.title || "",
        compose_present: !!compose,
        compose_text_len: compose ? (compose.innerText || "").trim().length : 0,
        compose_text_preview: compose ? squash(compose.innerText || "") : "",
        post_button_present: !!button,
        post_button_text: button ? squash(button.innerText || button.textContent || "", 120) : "",
        post_button_aria_disabled: button ? (button.getAttribute("aria-disabled") || "") : "",
        post_button_disabled: button ? !!button.disabled : false,
        post_button_testid: button ? (button.getAttribute("data-testid") || "") : "",
        alerts: textList('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]'),
        toasts: textList('[data-testid="toast"]'),
        dialog_text: dialog ? squash(dialog.innerText || "", 500) : "",
      };
    }, { composeSelector, postButtonSelector });
  } catch (err) {
    return {
      capture_error: err && err.message ? err.message : "unknown error",
    };
  }
}

module.exports = {
  captureComposeDiagnostics,
  HANDLE,
  STATUS_URL_RE,
  clearFile,
  isConfirmedStatusUrl,
  writeAttempt,
  writeResult,
};
