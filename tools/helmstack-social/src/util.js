"use strict";
/**
 * helmstack-social — small shared helpers.
 */

/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` calls in flight.
 *
 * WHY this exists: the engage() scorers are LLM calls, and the host app's LLM
 * may be a *subprocess* (hunter shells out to the Claude CLI). Fanning 25 of
 * those out at once starves them all — every call blew its kill-timeout, every
 * score fell back to 0, and LinkedIn engagement silently did nothing from
 * 2026-07-06 to 2026-08-10. Bounded concurrency keeps each call inside its
 * timeout while still overlapping the network waits.
 *
 * Results are returned in input order. Rejections propagate (the callers'
 * scorers already swallow their own errors).
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} limit          max concurrent calls (values < 1 mean serial)
 * @param {(item:T, index:number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const out = new Array(list.length);
  const width = Math.max(1, Math.min(limit | 0 || 1, list.length));
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

module.exports = { mapLimit };
