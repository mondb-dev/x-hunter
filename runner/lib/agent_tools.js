'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NARRATIVE_MAP_PATH = path.join(__dirname, '../../state/narrative_map.json');

// Helper functions to manage the narrative map state file
const readNarrativeMap = () => {
    try {
        if (fs.existsSync(NARRATIVE_MAP_PATH)) {
            const data = fs.readFileSync(NARRATIVE_MAP_PATH, 'utf8');
            // handle empty file
            if (data.trim() === '') {
                return {};
            }
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`[agent_tools] Error reading narrative map at ${NARRATIVE_MAP_PATH}:`, error);
    }
    return {}; // Return empty object if file doesn't exist or is invalid
};

const writeNarrativeMap = (data) => {
    try {
        fs.writeFileSync(NARRATIVE_MAP_PATH, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`[agent_tools] Error writing narrative map to ${NARRATIVE_MAP_PATH}:`, error);
    }
};

const TOOL_DECLARATIONS = [
    {
        name: 'narrative_tracker',
        description: 'Tracks and analyzes narrative strategies related to accountability evasion. Can log new statements/events, link them to an incident, and analyze patterns of obfuscation, blame-shifting, etc.',
        parameters: {
            type: 'OBJECT',
            properties: {
                action: {
                    type: 'STRING',
                    description: "The operation to perform: 'log_event', 'list_incidents', or 'analyze_incident'."
                },
                incident_id: {
                    type: 'STRING',
                    description: "A unique slug for the incident being tracked (e.g., 'senate_incident_may2026'). Required for 'log_event' and 'analyze_incident'."
                },
                incident_title: {
                    type: 'STRING',
                    description: "A human-readable title for the incident. Used when creating a new incident with 'log_event'."
                },
                event_data: {
                    type: 'OBJECT',
                    description: "An object containing the details of the narrative event. Required for 'log_event'.",
                    properties: {
                        statement: { type: 'STRING', description: 'The core claim or statement.' },
                        actor: { type: 'STRING', description: 'The person or entity making the statement.' },
                        source_url: { type: 'STRING', description: 'URL of the source, if available.' },
                        timestamp: { type: 'STRING', description: 'ISO 8601 timestamp of the event.' },
                        tactic_ids: { type: 'ARRAY', description: 'An array of tactic IDs from the narrative tactics taxonomy (e.g., ["blame_shifting", "minimization"]).' },
                        analysis: { type: 'STRING', description: "The agent's brief analysis of this event." },
                    }
                },
                analysis_query: {
                    type: 'STRING',
                    description: "The type of analysis to run for 'analyze_incident'. Options: 'timeline', 'actors', 'tactics'."
                }
            },
            required: ['action'],
        },
    },
];

const TOOL_EXECUTORS = {
    async narrative_tracker(args) {
        const { action, incident_id, incident_title, event_data, analysis_query } = args;

        try {
            const narrativeMap = readNarrativeMap();

            switch (action) {
                case 'log_event':
                    if (!incident_id || !event_data || !event_data.statement) {
                        return 'Error: `incident_id` and `event_data` (with at least a `statement`) are required for `log_event`.';
                    }

                    if (!narrativeMap[incident_id]) {
                        narrativeMap[incident_id] = {
                            title: incident_title || incident_id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                            created_at: new Date().toISOString(),
                            events: [],
                        };
                    }

                    const newEvent = {
                        id: `evt_${crypto.randomBytes(8).toString('hex')}`,
                        logged_at: new Date().toISOString(),
                        ...event_data,
                    };

                    narrativeMap[incident_id].events.push(newEvent);
                    writeNarrativeMap(narrativeMap);

                    return `Success: Logged new event with ID ${newEvent.id} under incident '${incident_id}'.`;

                case 'list_incidents':
                    const incidents = Object.keys(narrativeMap).map(id => ({
                        id,
                        title: narrativeMap[id].title,
                        event_count: narrativeMap[id].events.length,
                        created_at: narrativeMap[id].created_at,
                    }));
                    return JSON.stringify(incidents, null, 2);

                case 'analyze_incident':
                    if (!incident_id || !narrativeMap[incident_id]) {
                        return `Error: Incident with ID '${incident_id}' not found.`;
                    }
                    if (!analysis_query) {
                        return `Error: 'analysis_query' is required for 'analyze_incident'. Options: 'timeline', 'actors', 'tactics'.`;
                    }
                    
                    const incident = narrativeMap[incident_id];
                    let analysisResult = {};

                    switch (analysis_query) {
                        case 'timeline':
                            analysisResult = incident.events
                                .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
                                .map(e => ({
                                    timestamp: e.timestamp,
                                    actor: e.actor,
                                    statement: e.statement,
                                    tactics: e.tactic_ids || [],
                                }));
                            break;
                        
                        case 'actors':
                            const actors = {};
                            incident.events.forEach(e => {
                                if (!e.actor) return;
                                if (!actors[e.actor]) {
                                    actors[e.actor] = { count: 0, statements: [], tactics: {} };
                                }
                                actors[e.actor].count++;
                                actors[e.actor].statements.push(e.statement);
                                if (e.tactic_ids) {
                                    e.tactic_ids.forEach(t => {
                                        actors[e.actor].tactics[t] = (actors[e.actor].tactics[t] || 0) + 1;
                                    });
                                }
                            });
                            analysisResult = actors;
                            break;
                        
                        case 'tactics':
                            const tactics = {};
                            incident.events.forEach(e => {
                                if (e.tactic_ids && Array.isArray(e.tactic_ids)) {
                                    e.tactic_ids.forEach(tactic => {
                                        if (!tactics[tactic]) tactics[tactic] = 0;
                                        tactics[tactic]++;
                                    });
                                }
                            });
                            analysisResult = Object.entries(tactics)
                                .sort(([, a], [, b]) => b - a)
                                .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});
                            break;

                        default:
                            return `Error: Unknown analysis_query '${analysis_query}'. Options: 'timeline', 'actors', 'tactics'.`;
                    }
                    
                    return JSON.stringify(analysisResult, null, 2);

                default:
                    return `Error: Unknown action '${action}'. Valid actions are 'log_event', 'list_incidents', 'analyze_incident'.`;
            }
        } catch (err) {
            console.error('[narrative_tracker] tool error:', err);
            return `narrative_tracker error: ${err.message}`;
        }
    },
};

/**
 * Returns the list of tools available during the browse/thinking phase.
 */
const getBrowseTools = () => {
    return TOOL_DECLARATIONS;
};

/**
 * Returns the list of tools available during the tweet/drafting phase.
 * By default, this is a more restricted set.
 */
const getTweetTools = () => {
    // This tool is primarily for analysis, not for direct use in drafting tweets.
    return [];
};


module.exports = {
    TOOL_DECLARATIONS,
    TOOL_EXECUTORS,
    getBrowseTools,
    getTweetTools,
};
