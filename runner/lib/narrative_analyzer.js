'use strict';

const { MANIPULATION_PURPOSES, SPECIFIC_TACTICS } = require('./narrative_definitions');

/**
 * Parses a JSONL string into an array of objects.
 * @param {string} jsonlContent - The string content of the JSONL file.
 * @returns {Array<object>} An array of parsed log entries.
 */
function parseLedger(jsonlContent) {
  if (!jsonlContent || jsonlContent.trim() === '') {
    return [];
  }
  return jsonlContent
    .trim()
    .split('\n')
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
 * Analyzes the narrative tactic ledger to produce a summary.
 * @param {Array<object>} ledger - The parsed ledger data.
 * @param {object} options - Filtering options (e.g., days, actor).
 * @returns {object} An aggregated summary of tactics, purposes, and actors.
 */
function analyze(ledger, options = {}) {
  const { days = 30 } = options;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const filteredLedger = ledger.filter(entry => new Date(entry.timestamp) >= since);

  const summary = {
    period_days: days,
    total_entries: filteredLedger.length,
    tactic_counts: {},
    purpose_counts: {},
    actor_counts: {},
    source_counts: {},
  };

  // Initialize counts
  SPECIFIC_TACTICS.forEach(tactic => (summary.tactic_counts[tactic] = 0));
  MANIPULATION_PURPOSES.forEach(purpose => (summary.purpose_counts[purpose] = 0));

  for (const entry of filteredLedger) {
    if (entry.tactic && summary.tactic_counts.hasOwnProperty(entry.tactic)) {
      summary.tactic_counts[entry.tactic]++;
    }
    if (entry.purpose && summary.purpose_counts.hasOwnProperty(entry.purpose)) {
      summary.purpose_counts[entry.purpose]++;
    }
    if (entry.attribution && entry.attribution.actor) {
      const actor = entry.attribution.actor;
      summary.actor_counts[actor] = (summary.actor_counts[actor] || 0) + 1;
    }
    if (entry.source_url) {
        try {
            const domain = new URL(entry.source_url).hostname;
            summary.source_counts[domain] = (summary.source_counts[domain] || 0) + 1;
        } catch(e) {
            // ignore invalid URLs
        }
    }
  }

  return summary;
}

/**
 * Traces the propagation of a specific narrative or tactic.
 * @param {Array<object>} ledger - The parsed ledger data.
 * @param {object} options - Trace options (e.g., narrative_id, tactic).
 * @returns {Array<object>} A sorted list of entries related to the trace query.
 */
function trace(ledger, options = {}) {
  const { narrative_id, tactic, actor } = options;
  if (!narrative_id && !tactic && !actor) {
    return [];
  }

  const results = ledger.filter(entry => {
    let match = true;
    if (narrative_id && entry.narrative_id !== narrative_id) {
      match = false;
    }
    if (tactic && entry.tactic !== tactic) {
      match = false;
    }
    if (actor && entry.attribution?.actor !== actor) {
      match = false;
    }
    return match;
  });

  return results.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}


module.exports = {
  parseLedger,
  analyze,
  trace,
};
