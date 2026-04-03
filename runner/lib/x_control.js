'use strict';

const fs = require('fs');
const config = require('./config');

function loadXControl() {
  try {
    const data = JSON.parse(fs.readFileSync(config.X_CONTROL_PATH, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function isXSuppressed(kind) {
  const control = loadXControl();
  if (control.all === true) return true;

  if (kind === 'tweet' || kind === 'signal') return control.tweets === true;
  if (kind === 'quote') return control.quotes === true;
  if (kind === 'reply') return control.replies === true;

  return false;
}

function suppressionReason(kind) {
  const control = loadXControl();
  const reason = String(control.reason || '').trim();
  if (reason) return reason;
  return `operator_${kind}_suppressed`;
}

module.exports = {
  loadXControl,
  isXSuppressed,
  suppressionReason,
};
