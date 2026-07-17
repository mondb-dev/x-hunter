'use strict';
/**
 * runner/lib/x_thread.js — resolve a tweet's ancestor chain via the public
 * fxtwitter API (api.fxtwitter.com/status/<id>).
 *
 * WHY NOT THE BROWSER: X serves permalink pages to the automation session
 * WITHOUT the conversation timeline — one <article>, no "Replying to" header,
 * even on tweets that are provably replies (verified 2026-07-17 against a
 * mention that fxtwitter shows replying_to a SebastianHunts tweet, while the
 * logged-in DOM showed it standalone). DOM scraping therefore cannot see the
 * thread at all; the API exposes replying_to_status, so we walk up
 * parent-by-parent instead. Also used to give proactive replies thread
 * awareness without touching the browser.
 *
 * Best-effort: any failure returns what was collected so far ([] worst case),
 * never throws. fxtwitter is a third-party mirror — if it dies, replies
 * degrade to the old no-thread behavior, nothing breaks.
 *
 *   fetchAncestors(tweetId, {maxDepth}) -> [{id, user, text}] oldest first
 *                                          (excludes the tweet itself)
 *   fetchTweet(id) -> fxtwitter tweet object | null
 */

const API = 'https://api.fxtwitter.com/status/';

async function fetchTweet(id, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API + encodeURIComponent(String(id)), {
      headers: { 'user-agent': 'SebastianHunter/1.0' },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.tweet) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk replying_to_status links upward from `tweetId`. Returns the ancestors
 * oldest-first (root ≈ first entry when the chain fits in maxDepth), excluding
 * the starting tweet itself. Quoted tweets are folded into the text.
 */
async function fetchAncestors(tweetId, { maxDepth = 5 } = {}) {
  const out = [];
  let id = String(tweetId || '');
  for (let i = 0; i <= maxDepth && id; i++) {
    const t = await fetchTweet(id);
    if (!t) break;
    if (i > 0) {
      let text = (t.text || '').trim();
      if (t.quote && t.quote.text) {
        const qu = (t.quote.author && t.quote.author.screen_name) || '?';
        text += `\n[quoting @${qu}: "${String(t.quote.text).slice(0, 200)}"]`;
      }
      out.unshift({ id: String(t.id), user: (t.author && t.author.screen_name) || '?', text });
    }
    id = t.replying_to_status ? String(t.replying_to_status) : null;
  }
  return out;
}

module.exports = { fetchAncestors, fetchTweet };
