#!/usr/bin/env node
/**
 * runner/index_browse_notes.js — index browse_notes.md into the memory table
 *
 * Parses browse_notes.md by cycle markers written by pre_browse.js:
 *   --- Cycle N | ISO-timestamp ---
 *
 * Each cycle block is inserted into the memory table as type='browse_obs'
 * with file_path='browse_notes::cycle:N' (unique — ON CONFLICT DO NOTHING).
 * The existing backfill_embeddings.js picks them up on its next --memory run.
 *
 * Usage:
 *   node runner/index_browse_notes.js
 *   node runner/index_browse_notes.js --dry-run   (print without writing)
 *
 * Called from post_browse.js once per cycle (fast — idempotent inserts).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('./lib/config');
const { loadScraperDb } = require('./lib/db_backend');

const BROWSE_NOTES = config.BROWSE_NOTES_PATH;
const MARKER_RE    = /^--- Cycle (\d+) \| (.+) ---$/;
const DRY_RUN      = process.argv.includes('--dry-run');

function log(msg) { console.log(`[index-browse-notes] ${msg}`); }

/**
 * Parse browse_notes.md into per-cycle blocks.
 * Returns [{cycle, timestamp, date, hour, lines}]
 */
function parseCycleBlocks(raw) {
  const lines  = raw.split('\n');
  const blocks = [];
  let current  = null;

  for (const line of lines) {
    const m = MARKER_RE.exec(line.trim());
    if (m) {
      if (current && current.lines.length > 0) blocks.push(current);
      const ts   = new Date(m[2]);
      const date = isNaN(ts) ? null : ts.toISOString().slice(0, 10);
      const hour = isNaN(ts) ? '00'  : String(ts.getUTCHours()).padStart(2, '0');
      current = { cycle: parseInt(m[1], 10), timestamp: m[2], date, hour, lines: [] };
    } else if (current && line.trim()) {
      current.lines.push(line.trim());
    }
  }
  if (current && current.lines.length > 0) blocks.push(current);
  return blocks;
}

/**
 * Extract unique [TAG] labels from lines for keyword indexing.
 */
function extractTags(lines) {
  const tags = new Set();
  for (const l of lines) {
    const m = l.match(/^\[([^\]]+)\]/);
    if (m) tags.add(m[1].toLowerCase().replace(/[^a-z0-9_: -]/g, ''));
  }
  return [...tags].join(' ');
}

(async () => {
  if (!fs.existsSync(BROWSE_NOTES)) {
    log('browse_notes.md not found — nothing to index');
    process.exit(0);
  }

  const raw    = fs.readFileSync(BROWSE_NOTES, 'utf-8');
  const blocks = parseCycleBlocks(raw);

  if (!blocks.length) {
    log('no cycle markers found — run pre_browse first');
    process.exit(0);
  }

  log(`parsed ${blocks.length} cycle block(s) from browse_notes.md`);

  if (DRY_RUN) {
    for (const b of blocks) {
      console.log(`  cycle ${b.cycle} (${b.date} ${b.hour}): ${b.lines.length} lines`);
      b.lines.slice(0, 3).forEach(l => console.log(`    ${l.slice(0, 100)}`));
    }
    process.exit(0);
  }

  const db = loadScraperDb();

  let inserted = 0, skipped = 0;

  for (const block of blocks) {
    const filePath = `browse_notes::cycle:${block.cycle}`;
    const title    = `Browse Observations — Cycle ${block.cycle}` +
                     (block.date ? ` (${block.date} ${block.hour}:00)` : '');
    const text     = block.lines.join('\n');
    const keywords = extractTags(block.lines);
    const date     = block.date || new Date().toISOString().slice(0, 10);
    const hour     = block.hour || '00';

    try {
      // insertMemory uses ON CONFLICT(file_path) DO NOTHING — safe to re-run
      await db.insertMemory({
        type:         'browse_obs',
        date,
        hour,
        title,
        text_content: text,
        keywords,
        file_path:    filePath,
        indexed_at:   new Date().toISOString(),
      });
      inserted++;
      process.stdout.write('.');
    } catch (err) {
      // UNIQUE conflict = already indexed; any other error logged
      if (err.message && (err.message.includes('UNIQUE') || err.message.includes('unique'))) {
        skipped++;
      } else {
        log(`  error on cycle ${block.cycle}: ${err.message}`);
        skipped++;
      }
    }
  }

  process.stdout.write('\n');
  log(`done — inserted: ${inserted}, skipped (already indexed): ${skipped}`);
  log('run backfill_embeddings.js --memory to embed new entries');

  // Allow async Postgres pool to drain
  try { if (db.end) await db.end(); } catch {}
  process.exit(0);
})();
