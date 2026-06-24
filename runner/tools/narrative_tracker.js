'use strict';

const crypto = require('crypto');
const { MANIPULATION_PURPOSES, SPECIFIC_TACTICS } = require('../lib/narrative_definitions');
const NarrativeAnalyzer = require('../lib/narrative_analyzer');

const LEDGER_PATH = 'state/narrative_tactic_ledger.jsonl';

const tool = {
  name: 'narrative_tracker',
  description: 'Logs, traces, and analyzes narrative manipulation tactics. Use \'log\' to record a new tactic deployment, \'trace\' to see its propagation, and \'summarize\' to get statistics on actors or tactics.',
  version: '1.0.0',
  tags: ['analysis', 'state'],

  capabilities: {
    read: [LEDGER_PATH],
    write: [LEDGER_PATH],
    call_tools: [],
  },

  parameters: {
    type: 'OBJECT',
    properties: {
      operation: {
        type: 'STRING',
        description: 'The operation to perform: "log", "summarize", or "trace".',
        enum: ['log', 'summarize', 'trace'],
      },
      payload: {
        type: 'OBJECT',
        description: 'The data for the operation. Varies by operation.',
        properties: {
          // For 'log'
          tactic: { type: 'STRING', description: `The specific tactic used. Must be one of: ${SPECIFIC_TACTICS.join(', ')}` },
          purpose: { type: 'STRING', description: `The inferred purpose of the manipulation. Must be one of: ${MANIPULATION_PURPOSES.join(', ')}` },
          narrative: { type: 'STRING', description: 'A brief description of the narrative being pushed.' },
          analysis: { type: 'STRING', description: 'Your analysis of how the tactic is being applied.' },
          source_url: { type: 'STRING', description: 'The URL of the content where the tactic was observed (e.g., tweet, article).' },
          attribution: {
            type: 'OBJECT',
            properties: {
              actor: { type: 'STRING', description: 'The entity (e.g., @username, organization) deploying the tactic.' },
              type: { type: 'STRING', description: 'The type of actor (e.g., "Politician", "Media Outlet", "State Actor").' },
            },
          },
          narrative_id: { type: 'STRING', description: 'Optional ID to link related narrative events. If omitted, a new one is generated from the narrative text.' },

          // For 'summarize'
          days: { type: 'INTEGER', description: 'The number of past days to include in the summary (default 30).' },

          // For 'trace'
          // actor, tactic, and narrative_id are reused from 'log'
        },
      },
    },
    required: ['operation', 'payload'],
  },

  execute(args, context) {
    const { operation, payload } = args;
    if (!payload) {
      return `Error: payload is required for operation '${operation}'.`;
    }

    let ledgerContent = '';
    try {
      ledgerContent = context.readState(LEDGER_PATH);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // File doesn't exist, which is fine for the first log.
    }

    switch (operation) {
      case 'log': {
        const { tactic, purpose, narrative, analysis, source_url, attribution } = payload;

        if (!tactic || !SPECIFIC_TACTICS.includes(tactic)) {
          return `Error: Invalid or missing 'tactic'. Must be one of: ${SPECIFIC_TACTICS.join(', ')}.`;
        }
        if (!purpose || !MANIPULATION_PURPOSES.includes(purpose)) {
          return `Error: Invalid or missing 'purpose'. Must be one of: ${MANIPULATION_PURPOSES.join(', ')}.`;
        }
        if (!narrative || !analysis || !source_url) {
          return 'Error: Missing required payload fields for "log": narrative, analysis, and source_url are required.';
        }

        const narrative_id = payload.narrative_id || crypto.createHash('sha256').update(narrative).digest('hex').substring(0, 16);

        const logEntry = {
          id: `nt-${crypto.randomBytes(12).toString('hex')}`,
          timestamp: new Date().toISOString(),
          narrative_id,
          tactic,
          purpose,
          narrative,
          analysis,
          source_url,
          attribution: attribution || null,
          cycle: context.cycle,
        };

        const newLedgerContent = (ledgerContent ? ledgerContent + '\n' : '') + JSON.stringify(logEntry);
        context.writeState(LEDGER_PATH, newLedgerContent);

        return `Successfully logged narrative tactic '${tactic}' with id ${logEntry.id}.`;
      }

      case 'summarize': {
        const ledger = NarrativeAnalyzer.parseLedger(ledgerContent);
        if (ledger.length === 0) {
            return 'Narrative Tactic Ledger is empty. Nothing to summarize.';
        }
        const summary = NarrativeAnalyzer.analyze(ledger, { days: payload.days });
        return JSON.stringify(summary, null, 2);
      }

      case 'trace': {
        const { narrative_id, tactic, actor } = payload;
        if (!narrative_id && !tactic && !actor) {
            return 'Error: For "trace", payload must contain at least one of: narrative_id, tactic, or actor.';
        }
        const ledger = NarrativeAnalyzer.parseLedger(ledgerContent);
        if (ledger.length === 0) {
            return 'Narrative Tactic Ledger is empty. Nothing to trace.';
        }
        const traceResults = NarrativeAnalyzer.trace(ledger, { narrative_id, tactic, actor });
        return JSON.stringify(traceResults, null, 2);
      }

      default:
        return `Error: Unknown operation '${operation}'.`;
    }
  },
};

module.exports = tool;
