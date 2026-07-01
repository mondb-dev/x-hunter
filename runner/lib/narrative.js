'use strict';

/**
 * @fileoverview Shared library for narrative analysis, including schemas and constants.
 */

/**
 * The JSON schema for the parameters of the narrative_component_logger tool.
 * This defines the structure for logging a discrete narrative component.
 * @type {object}
 */
const NARRATIVE_COMPONENT_SCHEMA = {
  type: 'object',
  properties: {
    source_url: {
      type: 'string',
      description: 'URL of the content where the narrative was observed.',
    },
    source_text_snippet: {
      type: 'string',
      description: 'A short quote or snippet of the observed text.',
    },
    core_narrative_claim: {
      type: 'string',
      description: "The central claim of the narrative (e.g., 'Immigration is a tool for NWO').",
    },
    attributed_actors: {
      type: 'array',
      items: { type: 'string' },
      description: 'Entities the narrative blames or credits (e.g., WEF, Soros).',
    },
    rhetorical_devices: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific rhetorical tactics or linked conspiracies (e.g., Kalergi Plan, Great Reset).',
    },
    stated_objective: {
      type: 'string',
      description: 'The alleged goal of the narrative actors (e.g., undermine sovereignty).',
    },
    emotional_tone_markers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Keywords or phrases indicating the emotional tone (e.g., fear, anger, urgency).',
    },
  },
  required: ['core_narrative_claim'],
};

module.exports = {
  NARRATIVE_COMPONENT_SCHEMA,
};
