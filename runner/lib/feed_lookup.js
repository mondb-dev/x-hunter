'use strict';
/**
 * runner/lib/feed_lookup.js — recover a scraped post's own text by tweet ID.
 *
 * WHY: quote-tweet commentary is published next to the quoted post's card, so a
 * misread (or an invented quotation) of that post ships too. Every gate that
 * wants to check commentary against what the source actually said needs the
 * source text — and the only local record of it is state/feed_buffer.jsonl.
 *
 * That file is large (>100MB) and append-ordered, so we scan it BACKWARDS in
 * chunks: quote targets are near-current, so the match is normally in the last
 * few MB and the scan stops early.
 *
 * Best-effort by design: a miss returns null. Callers decide whether an
 * unverifiable source is fatal (it is, for quotation checks — see
 * lib/voice_filter.js checkQuotations).
 */

const fs   = require('fs');
const path = require('path');
const config = require('./config');

// FEED_BUFFER_PATH lets a worktree point at the live buffer (runtime state is
// not checked in, so a worktree's own state/ has no feed_buffer.jsonl).
const FEED_PATH = process.env.FEED_BUFFER_PATH
  ? path.resolve(process.env.FEED_BUFFER_PATH)
  : path.join(config.STATE_DIR, 'feed_buffer.jsonl');

const CHUNK   = 1 << 20;        // 1MB per read
const MAX_SCAN = 64 * CHUNK;    // give up after 64MB — older than any quote target

/** Extract the numeric status ID from an x.com/twitter.com status URL. */
function tweetIdFrom(url) {
  const m = String(url || '').match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Look up a scraped post by tweet ID or status URL.
 * @param {string} idOrUrl - status ID or full status URL
 * @returns {{id:string, text:string, handle:string, name:string, ts:string}|null}
 */
function lookup(idOrUrl) {
  const id = /^\d+$/.test(String(idOrUrl || '')) ? String(idOrUrl) : tweetIdFrom(idOrUrl);
  if (!id) return null;

  let fd;
  try { fd = fs.openSync(FEED_PATH, 'r'); }
  catch { return null; }

  try {
    const size = fs.fstatSync(fd).size;
    const needle = `"id":"${id}"`;
    const buf = Buffer.alloc(CHUNK);
    let pos = size;
    let tail = '';       // bytes carried over from the previous (later) chunk
    let scanned = 0;

    while (pos > 0 && scanned < MAX_SCAN) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      fs.readSync(fd, buf, 0, len, pos);
      scanned += len;

      const text = buf.toString('utf-8', 0, len) + tail;
      const lines = text.split('\n');
      // The first element may be a partial line (its start is in an earlier
      // chunk) — carry it into the next iteration rather than parsing it.
      tail = pos > 0 ? lines.shift() : '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || line.indexOf(needle) === -1) continue;
        try {
          const rec = JSON.parse(line);
          if (String(rec.id) !== id) continue;
          return {
            id:     String(rec.id),
            text:   String(rec.text || ''),
            handle: String(rec.u  || ''),
            name:   String(rec.dn || ''),
            ts:     String(rec.ts_iso || ''),
          };
        } catch { /* truncated/corrupt line — keep scanning */ }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

module.exports = { lookup, tweetIdFrom };
