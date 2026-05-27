'use strict';

const utils = require('../runner/lib/narrative_tracker_utils.js');

const NARRATIVE_LEDGER_PATH = 'state/narrative_tactic_ledger.jsonl';

function logTactic(payload, context) {
  const { isValid, error } = utils.validateLogPayload(payload);
  if (!isValid) {
    return { success: false, error };
  }

  const newEvent = utils.createEvent(payload);

  try {
    const ledgerContent = context.readState(NARRATIVE_LEDGER_PATH) || '';
    const newLedgerContent = ledgerContent + (ledgerContent ? '\n' : '') + JSON.stringify(newEvent);
    context.writeState(NARRATIVE_LEDGER_PATH, newLedgerContent);
    return { success: true, eventId: newEvent.eventId };
  } catch (e) {
    return { success: false, error: `Failed to write to ledger: ${e.message}` };
  }
}

function traceTactic(payload, ledger) {
  const { isValid, error } = utils.validateTracePayload(payload);
  if (!isValid) {
    return { success: false, error };
  }

  const sourceEvent = ledger.find(event => event.eventId === payload.eventId);
  if (!sourceEvent) {
    return { success: false, error: `Event with ID ${payload.eventId} not found.` };
  }

  const propagations = ledger.filter(event => event.sourceEventId === payload.eventId);

  return {
    success: true,
    trace: {
      source: sourceEvent,
      propagations: propagations,
    },
  };
}

function summarize(payload, ledger) {
  const { isValid, error } = utils.validateSummarizePayload(payload);
  if (!isValid) {
    return { success: false, error };
  }

  if (payload.type === 'actor') {
    const actorEvents = ledger.filter(event => event.actor && event.actor.id === payload.id);
    const summary = actorEvents.reduce((acc, event) => {
      acc[event.tacticId] = (acc[event.tacticId] || 0) + 1;
      return acc;
    }, {});
    return { success: true, summary: { actorId: payload.id, tactics: summary } };
  }

  if (payload.type === 'tactic') {
    const tacticEvents = ledger.filter(event => event.tacticId === payload.id);
    const summary = tacticEvents.reduce((acc, event) => {
      if (event.actor && event.actor.id) {
        acc[event.actor.id] = (acc[event.actor.id] || 0) + 1;
      }
      return acc;
    }, {});
    return { success: true, summary: { tacticId: payload.id, actors: summary } };
  }

  return { success: false, error: 'Invalid summary type.' };
}

module.exports = {
  name: 'narrative_tracker',
  description:
    "Logs, traces, and analyzes narrative manipulation tactics. Use 'log' to record a new tactic deployment, 'trace' to see its propagation, and 'summarize' to get statistics on actors or tactics.",
  version: '1.0.0',
  tags: ['narrative', 'analysis', 'attribution'],

  capabilities: {
    read: [NARRATIVE_LEDGER_PATH],
    write: [NARRATIVE_LEDGER_PATH],
    call_tools: [],
  },

  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['log', 'trace', 'summarize'],
        description: "The operation to perform: 'log' a new tactic, 'trace' its spread, or 'summarize' usage.",
      },
      payload: {
        type: 'object',
        description:
          'Data for the operation. For "log", include tactic details. For "trace", include "eventId". For "summarize", include "type" (\'actor\' or \'tactic\') and "id".',
      },
    },
    required: ['operation', 'payload'],
  },

  execute(args, context) {
    const { operation, payload } = args;

    if (operation === 'log') {
      return logTactic(payload, context);
    }

    // For trace and summarize, we need to read the ledger first.
    let ledger;
    try {
      const ledgerContent = context.readState(NARRATIVE_LEDGER_PATH) || '';
      ledger = utils.parseLedger(ledgerContent);
    } catch (e) {
      return { success: false, error: `Failed to read ledger: ${e.message}` };
    }

    switch (operation) {
      case 'trace':
        return traceTactic(payload, ledger);
      case 'summarize':
        return summarize(payload, ledger);
      default:
        return { success: false, error: `Unknown operation: ${operation}` };
    }
  },
};
