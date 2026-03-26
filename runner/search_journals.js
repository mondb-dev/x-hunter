'use strict';

/**
 * runner/search_journals.js — memory recall wrapper for composition grounding
 *
 * Wraps recall.js as a callable function for pre-composition pipelines.
 * Used by pre_tweet.js to pre-load relevant memory before the tweet agent runs,
 * ensuring the agent has grounded context for any past references.
 *
 * Also works as a CLI for testing:
 *   node runner/search_journals.js "Iran escalation"
 *   node runner/search_journals.js "media manipulation" journal 5
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RECALL = path.join(ROOT, 'runner', 'recall.js');

/**
 * Search Sebastian's journal archive, checkpoints, belief reports, articles.
 *
 * @param {Object} opts
 * @param {string} opts.query - Keywords to search for
 * @param {string} [opts.type] - Filter: journal | checkpoint | belief_report | article | ponder
 * @param {number} [opts.limit=5] - Max results
 * @returns {string} Formatted recall output, or error message
 */
function searchJournals({ query, type, limit }) {
  const args = ['--query', `"${query.replace(/"/g, '\\"')}"`, '--print'];
  if (type)  args.push('--type', type);
  if (limit) args.push('--limit', String(limit));

  try {
    const result = execSync(
      `node "${RECALL}" ${args.join(' ')}`,
      { encoding: 'utf-8', timeout: 30_000 }
    );
    return result.trim() || '(no matching entries found)';
  } catch (e) {
    return '(search failed: ' + (e.message || 'unknown error') + ')';
  }
}

module.exports = { searchJournals };

// CLI mode for testing
if (require.main === module) {
  const query = process.argv[2] || 'Iran';
  const type  = process.argv[3] || undefined;
  const limit = parseInt(process.argv[4] || '5', 10);
  console.log(searchJournals({ query, type, limit }));
}
