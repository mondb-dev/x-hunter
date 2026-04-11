#!/usr/bin/env node
'use strict';
/**
 * runner/trim_feed_digest.js — time-based feed digest rotation
 *
 * Keeps only entries from the last 72h in state/feed_digest.txt.
 * Digest entries are separated by "── YYYY-MM-DD HH:MM ──" headers.
 * Older blocks are dropped (not archived — stale feed has no recall value).
 *
 * Called from post_browse.js every 6 cycles (~2h) via stamp file.
 * Safe to run any time; idempotent.
 */

const fs   = require('fs');
const path = require('path');

const ROOT        = path.resolve(__dirname, '..');
const DIGEST_PATH = path.join(ROOT, 'state', 'feed_digest.txt');
const WINDOW_MS   = 72 * 60 * 60 * 1000; // 72 hours

function log(msg) { console.log(`[trim_digest] ${msg}`); }

// Match the block header written by scraper/collect.js:
// "── 2026-04-09 03:54 ── (N posts, ...)"
const HEADER_RE = /^── (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ──/;

function run() {
  if (!fs.existsSync(DIGEST_PATH)) return;

  const raw     = fs.readFileSync(DIGEST_PATH, 'utf-8');
  const lines   = raw.split('\n');
  const cutoff  = Date.now() - WINDOW_MS;

  // Split into blocks delimited by header lines
  const blocks = [];
  let current  = [];

  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      if (current.length) blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);

  // Filter: keep blocks whose header timestamp is within the window
  const kept = blocks.filter(block => {
    const m = block[0]?.match(HEADER_RE);
    if (!m) return true; // no header → keep (preamble / orphan lines)
    const ts = new Date(`${m[1]}T${m[2]}:00Z`).getTime();
    return ts >= cutoff;
  });

  const before = lines.length;
  const after  = kept.reduce((n, b) => n + b.length, 0);

  if (after >= before) {
    log(`nothing to trim (${before} lines, all within 72h window)`);
    return;
  }

  fs.writeFileSync(DIGEST_PATH, kept.map(b => b.join('\n')).join('\n'), 'utf-8');
  log(`trimmed ${before - after} lines → ${after} remaining (72h window)`);
}

try { run(); } catch (err) { console.error(`[trim_digest] error: ${err.message}`); }
