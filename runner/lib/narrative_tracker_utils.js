'use strict';

const crypto = require('crypto');

/**
 * Parses the content of a .jsonl file into an array of objects.
 * @param {string} ledgerContent - The raw string content of the .jsonl file.
 * @returns {Array<Object>} An array of parsed JSON objects.
 */
function parseLedger(ledgerContent) {
  if (!ledgerContent || ledgerContent.trim() === '') {
    return [];
  }
  return ledgerContent
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        // Ignore malformed lines
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Validates the payload for a 'log' operation.
 * @param {Object} payload - The payload to validate.
 * @returns {{isValid: boolean, error: string|null}}
 */
function validateLogPayload(payload) {
  const requiredFields = [
    'tacticId',
    'tacticLabel',
    'actor',
    'contentId',
    'contentSnippet',
    'reasoning',
    'confidence',
  ];
  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null) {
      return { isValid: false, error: `Missing required field in payload: ${field}` };
    }
  }
  if (typeof payload.actor !== 'object' || !payload.actor.id) {
    return { isValid: false, error: 'Invalid actor object in payload. Must have an "id" property.' };
  }
  if (typeof payload.confidence !== 'number' || payload.confidence < 0 || payload.confidence > 1) {
    return { isValid: false, error: 'Confidence must be a number between 0 and 1.' };
  }
  return { isValid: true, error: null };
}

/**
 * Validates the payload for a 'trace' operation.
 * @param {Object} payload - The payload to validate.
 * @returns {{isValid: boolean, error: string|null}}
 */
function validateTracePayload(payload) {
  if (!payload.eventId) {
    return { isValid: false, error: 'Missing required field in payload: eventId' };
  }
  return { isValid: true, error: null };
}

/**
 * Validates the payload for a 'summarize' operation.
 * @param {Object} payload - The payload to validate.
 * @returns {{isValid: boolean, error: string|null}}
 */
function validateSummarizePayload(payload) {
  if (!payload.type || !['actor', 'tactic'].includes(payload.type)) {
    return { isValid: false, error: 'Invalid or missing "type" in payload. Must be "actor" or "tactic".' };
  }
  if (!payload.id) {
    return { isValid: false, error: `Missing required field in payload: id (for type ${payload.type})` };
  }
  return { isValid: true, error: null };
}

/**
 * Creates a new tactic deployment event object.
 * @param {Object} payload - The validated payload from the 'log' operation.
 * @returns {Object} The new event object.
 */
function createEvent(payload) {
  return {
    eventId: crypto.randomUUID(),
    tacticId: payload.tacticId,
    tacticLabel: payload.tacticLabel,
    timestamp: new Date().toISOString(),
    contentId: payload.contentId,
    contentSnippet: payload.contentSnippet,
    actor: payload.actor,
    sourceEventId: payload.sourceEventId || null,
    analysis: {
      confidence: payload.confidence,
      reasoning: payload.reasoning,
    },
  };
}

module.exports = {
  parseLedger,
  validateLogPayload,
  validateTracePayload,
  validateSummarizePayload,
  createEvent,
};
