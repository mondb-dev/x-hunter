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

/**
 * Broadcast hold during the research agenda's foundation phase: the seeded axes
 * have almost no evidence yet and no brief has been published, so there is
 * nothing grounded to say. Replies are deliberately NOT held — answering a
 * person who asked something is not broadcasting an ungrounded opinion.
 * Inert until agenda_bootstrap.js --apply has installed the agenda plan.
 */
function agendaHold(kind) {
  if (kind !== 'tweet' && kind !== 'signal' && kind !== 'quote' && kind !== 'repost') return false;
  try { return require('./agenda_phase').agendaPhase().holdOutbound === true; } catch { return false; }
}

function isXSuppressed(kind) {
  const control = loadXControl();
  if (control.all === true) return true;
  if (agendaHold(kind)) return true;

  if (kind === 'tweet' || kind === 'signal') return control.tweets === true;
  if (kind === 'quote') return control.quotes === true;
  if (kind === 'reply') return control.replies === true;
  if (kind === 'repost') return control.reposts === true;

  return false;
}

function suppressionReason(kind) {
  const control = loadXControl();
  if (control.all !== true && agendaHold(kind)) return 'agenda_foundation_phase';
  const reason = String(control.reason || '').trim();
  if (reason) return reason;
  return `operator_${kind}_suppressed`;
}

module.exports = {
  loadXControl,
  isXSuppressed,
  suppressionReason,
  agendaHold,
};
