'use strict';

const { NARRATIVE_TACTICS } = require('../lib/narrative_tactics.js');

const TACTIC_IDS = new Set(NARRATIVE_TACTICS.map(t => t.id));
const CATALOG_FILE = 'state/narrative_catalog.jsonl';

module.exports = {
  name: 'catalog_narrative_tactic',
  description: 'Logs an observed instance of a narrative manipulation tactic to the catalog for later analysis. Use `get_narrative_tactics` to see available `tactic_id` values.',
  version: '1.0.0',
  tags: ['narrative', 'analysis', 'catalog', 'write'],

  parameters: {
    type: 'object',
    properties: {
      tactic_id: {
        type: 'string',
        description: 'The unique identifier of the tactic being logged (e.g., "splicing_doctoring_evidence").',
      },
      context: {
        type: 'string',
        description: 'The text or a description of the content where the tactic was observed.',
      },
      source_url: {
        type: 'string',
        description: 'The URL of the source material (e.g., tweet URL, article link).',
      },
      notes: {
        type: 'string',
        description: 'Optional additional notes or analysis about the observation.',
      }
    },
    required: ['tactic_id', 'context', 'source_url'],
  },

  capabilities: {
    read: [CATALOG_FILE],
    write: [CATALOG_FILE],
    call_tools: [],
  },

  /**
   * Executes the tool to log a narrative tactic.
   * @param {object} args - The arguments for the tool.
   * @param {object} context - The context of the tool execution, with readState/writeState.
   * @returns {string} - A JSON string with the result of the operation.
   */
  execute(args, context) {
    const { tactic_id, context: tactic_context, source_url, notes } = args;

    if (!tactic_id || !tactic_context || !source_url) {
      return JSON.stringify({ success: false, error: 'Missing required arguments: tactic_id, context, source_url.' });
    }

    if (!TACTIC_IDS.has(tactic_id)) {
      return JSON.stringify({ success: false, error: `Invalid tactic_id: "${tactic_id}". Use the "get_narrative_tactics" tool to see a list of valid IDs.` });
    }

    const newEntry = {
      timestamp: new Date().toISOString(),
      cycle: context.cycle || null,
      tactic_id,
      source_url,
      context: tactic_context,
      notes: notes || null,
    };

    try {
      let currentContent = '';
      try {
        // readState returns the content of the file, or throws if it doesn't exist.
        currentContent = context.readState(CATALOG_FILE);
      } catch (e) {
        // If the file doesn't exist, that's fine. We'll create it.
        if (e.code !== 'ENOENT' && !e.message.includes('not found')) {
          throw e; // Re-throw other errors
        }
      }

      const newContent = (currentContent ? currentContent.trimEnd() + '\n' : '') + JSON.stringify(newEntry);
      
      context.writeState(CATALOG_FILE, newContent);

      return JSON.stringify({ success: true, message: `Tactic "${tactic_id}" logged successfully.` });
    } catch (error) {
      // Log the error for debugging on the runner side
      console.error(`[catalog_narrative_tactic] Error: ${error.message}`);
      // Return a structured error to the agent
      return JSON.stringify({ success: false, error: `Failed to write to catalog: ${error.message}` });
    }
  },
};
