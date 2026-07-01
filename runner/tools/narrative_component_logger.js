'use strict';

const crypto = require('crypto');
const { NARRATIVE_COMPONENT_SCHEMA } = require('../lib/narrative.js');

const name = 'narrative_component_logger';
const description = "Logs a structured record of a narrative's components (claim, actors, devices, objective, tone) to a persistent log for later analysis.";
const version = '1.0.0';

const capabilities = {
  read: [], // No direct file reads, using require() for schema
  write: ['state/narrative_component_log.jsonl'],
  call_tools: [],
};

// The tool's parameters are defined by the imported schema
const parameters = NARRATIVE_COMPONENT_SCHEMA;

/**
 * Executes the tool to log a structured narrative component.
 * @param {object} args - The arguments for the tool, matching NARRATIVE_COMPONENT_SCHEMA.
 * @param {object} context - The execution context provided by the tool runner.
 * @returns {object} A result object, either {success: true, ...} or {error: '...'}.
 */
function execute(args, context) {
  if (!args.core_narrative_claim || typeof args.core_narrative_claim !== 'string' || args.core_narrative_claim.trim() === '') {
    return { error: '`core_narrative_claim` is a required, non-empty string parameter.' };
  }

  const timestamp = new Date().toISOString();
  // Create a unique ID for the log entry
  const id = `ncl_${timestamp.replace(/[-:.]/g, '')}_${crypto.randomBytes(4).toString('hex')}`;

  const logEntry = {
    id,
    timestamp,
    source_url: args.source_url || null,
    source_text_snippet: args.source_text_snippet || null,
    core_narrative_claim: args.core_narrative_claim.trim(),
    attributed_actors: Array.isArray(args.attributed_actors) ? args.attributed_actors : [],
    rhetorical_devices: Array.isArray(args.rhetorical_devices) ? args.rhetorical_devices : [],
    stated_objective: args.stated_objective || null,
    emotional_tone_markers: Array.isArray(args.emotional_tone_markers) ? args.emotional_tone_markers : [],
    cycle: context.cycle || null,
  };

  try {
    const logFilePath = 'state/narrative_component_log.jsonl';
    let existingContent = '';
    try {
      // readState is expected to fail if the file doesn't exist.
      existingContent = context.readState(logFilePath);
    } catch (e) {
      // If file not found, we start fresh. Other errors are unexpected.
      if (e.message && !e.message.includes('not found')) {
        throw e; // Re-throw unexpected errors
      }
    }

    const newEntryLine = JSON.stringify(logEntry);
    const newContent = (existingContent ? existingContent.trimEnd() + '\n' : '') + newEntryLine;

    context.writeState(logFilePath, newContent);

    return { success: true, id: logEntry.id, message: `Narrative component logged.` };
  } catch (err) {
    return { error: `Failed to write to log file: ${err.message}` };
  }
}

module.exports = {
  name,
  description,
  version,
  capabilities,
  parameters,
  execute,
};
