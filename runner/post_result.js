"use strict";

const fs = require("fs");

const HANDLE = "sebastianhunts";
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

module.exports = {
  HANDLE,
  STATUS_URL_RE,
  clearFile,
  isConfirmedStatusUrl,
  writeAttempt,
  writeResult,
};
