'use strict';

const { NARRATIVE_TACTICS } = require('../lib/narrative_tactics.js');

module.exports = {
  name: 'get_narrative_tactics',
  description: 'Returns a list of all known narrative manipulation tactics that can be cataloged. The agent can use this list to understand what `tactic_id` values are valid for the `catalog_narrative_tactic` tool.',
  version: '1.0.0',
  tags: ['narrative', 'analysis', 'catalog'],
  
  parameters: {
    type: 'object',
    properties: {},
  },

  capabilities: {
    read: [],
    write: [],
    call_tools: [],
  },

  /**
   * Executes the tool.
   * @param {object} args - The arguments for the tool.
   * @param {object} context - The context of the tool execution.
   * @returns {string} - A JSON string of the narrative tactics.
   */
  execute(args, context) {
    try {
      // Return the list of tactics, formatted for the agent.
      const result = {
        tactics: NARRATIVE_TACTICS.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
        })),
      };
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return JSON.stringify({ error: `Failed to get narrative tactics: ${error.message}` });
    }
  },
};
