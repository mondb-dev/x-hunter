/**
 * runner/intelligence/lib/source_data.js — load source credibility data
 *
 * Checks intelligence.db sources table first, falls back to source_registry.json.
 * Used by both the batch pipeline and on-demand verification.
 *
 * Exports:
 *   loadSourceData(handle, idb, stateDir, isPostgres) → Promise<{credibility_tier, ng_score}>
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Load credibility data for a source handle.
 *
 * @param {string} handle - X/Twitter handle (without @)
 * @param {object} [idb] - intelligence DB instance (optional)
 * @param {string} stateDir - path to state/ directory
 * @param {boolean} [isPostgres=false] - whether idb is a pg client
 * @returns {Promise<{credibility_tier?: number, ng_score?: number}>}
 */
async function loadSourceData(handle, idb, stateDir, isPostgres = false) {
  if (!handle) return {};
  handle = handle.replace(/^@/, '').toLowerCase();

  // Try intelligence.db first
  if (idb) {
    try {
      let row;
      if (isPostgres) {
        const result = await idb.query(
          'SELECT credibility_tier, ng_score FROM sources WHERE handle = $1',
          [handle]
        );
        row = result.rows[0];
      } else {
        row = idb.prepare('SELECT credibility_tier, ng_score FROM sources WHERE handle = ?').get(handle);
      }
      if (row && row.credibility_tier) return row;
    } catch {}
  }

  // Fall back to source_registry.json
  try {
    const registry = JSON.parse(fs.readFileSync(
      path.join(stateDir, 'source_registry.json'), 'utf-8'
    ));
    const acct = registry.accounts?.[handle];
    if (acct) return { credibility_tier: acct.credibility_tier, ng_score: acct.ng_score };
  } catch {}

  return {};
}

module.exports = { loadSourceData };
