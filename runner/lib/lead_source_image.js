'use strict';
/**
 * runner/lib/lead_source_image.js — pick the lead source-with-image for a freshly
 * composed post, so the image-posting path (which only fires when a source URL is
 * set) triggers autonomously instead of never.
 *
 * The tweet is composed from state/browse_notes.md, which carries the source URLs
 * (articles + X status links) the notes were drawn from. This picks the ONE source
 * the composed post is most about AND that actually exposes an og:image, then the
 * poster copies that image + attributes it.
 *
 *   pickLeadSource(text, notes, opts) -> { url, source } | null   (async)
 *
 * Selection is deterministic (word-overlap relevance), not another LLM call:
 *   1. Extract candidate URLs + the note line each appears on. X/Twitter URLs
 *      are excluded outright: x.com now serves an og:image to logged-out fetches
 *      (it used to be a login wall), but that image is the tweet's arbitrary
 *      media/video thumbnail — this is how a US DOJ presser frame ended up on a
 *      Philippine-politics post.
 *   2. Score each by overlap between the post text and that line's words.
 *   3. In descending relevance, fetch each candidate and keep the first that has
 *      an og:image AND whose own og:title/og:description overlaps the post
 *      (>= minPageOverlap content words, at least one a proper noun from the
 *      post). The note-line score alone proved too weak — generic words
 *      ("justice", "prosecution") let unrelated stories through. Up to
 *      `maxProbe` fetches.
 *
 * A miss (no candidate clears the bar) returns null → the post goes out text-only,
 * exactly as before. No behavior change when browse notes carry no usable source.
 */

const { extractOgImage, hostLabel } = require('./source_image');

const UA = 'Mozilla/5.0 (Macintosh) SebastianHunter/1.0';
const STOP = new Set(('the a an and or but of to in on at for with from by as is are was were be been being this that these those it its ' +
  'he she they we you i his her their our your my me us them who what which when where why how not no yes do does did done has have had ' +
  'will would can could should may might must just so if then than out up down over under about into via amp rt').split(' '));

function words(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9@#]+/g) || [];
}

function contentWords(s) {
  return words(s).filter((w) => w.length > 2 && !STOP.has(w));
}

// x.com serves a tweet's media/video thumbnail as og:image now — never topical
// enough to illustrate a post, so tweet links are note sources, not image sources.
const X_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//i;

/** Proper-noun-ish content words: capitalized in the post body (names, places, orgs). */
function properNouns(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\b[A-Z][a-zA-Z]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

/** Extract candidate URLs with the surrounding note line as relevance context. */
function candidatesFromNotes(notes) {
  const seen = new Set();
  const out = [];
  for (const line of String(notes || '').split('\n')) {
    const urls = line.match(/https?:\/\/[^\s)<>"']+/g);
    if (!urls) continue;
    for (let u of urls) {
      u = u.replace(/[.,);]+$/, ''); // trim trailing punctuation
      if (seen.has(u)) continue;
      seen.add(u);
      out.push({ url: u, context: line });
    }
  }
  return out;
}

/**
 * @param {string} text   the composed post body
 * @param {string} notes  browse-notes text the post was composed from
 * @param {object} [opts]
 * @param {number} [opts.minScore=2]  minimum overlapping content words to consider a candidate relevant
 * @param {number} [opts.minPageOverlap=3]  minimum content words the page's og:title/description must share with the post
 * @param {number} [opts.maxProbe=4]  max candidates to fetch-probe for an og:image
 * @param {number} [opts.timeoutMs=6000]  per-fetch timeout
 * @returns {Promise<{url:string, source:string}|null>}
 */
async function pickLeadSource(text, notes, { minScore = 2, minPageOverlap = 3, maxProbe = 4, timeoutMs = 6000 } = {}) {
  const postWords = new Set(contentWords(text));
  if (!postWords.size) return null;
  const properWords = properNouns(text);

  const scored = candidatesFromNotes(notes)
    .filter((c) => !X_URL.test(c.url))
    .map((c) => {
      const ctxWords = new Set(contentWords(c.context));
      let score = 0;
      for (const w of ctxWords) if (postWords.has(w)) score++;
      return { ...c, score };
    })
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score);

  let probed = 0;
  for (const cand of scored) {
    if (probed >= maxProbe) break;
    probed++;
    const page = await probePage(cand.url, timeoutMs);
    if (!page || !page.hasImage) continue;
    if (!pageCoherent(page, postWords, properWords, minPageOverlap)) continue;
    return { url: cand.url, source: hostLabel(cand.url) };
  }
  return null;
}

/**
 * The page itself must be about what the post is about: its og:title/description
 * shares >= minOverlap content words with the post, at least one of them a proper
 * noun (name/place/org) from the post. A page with no title/description fails —
 * an unverifiable image is worse than no image.
 */
function pageCoherent(page, postWords, properWords, minOverlap) {
  const metaWords = new Set(contentWords(`${page.title} ${page.description}`));
  let overlap = 0;
  let proper = 0;
  for (const w of metaWords) {
    if (postWords.has(w)) overlap++;
    if (properWords.has(w)) proper++;
  }
  return overlap >= minOverlap && proper >= 1;
}

/** Fetch the URL's HTML and pull og:image presence + og:title/og:description (HTML only, no image bytes). */
async function probePage(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html')) return null;
    const html = await res.text();
    return {
      hasImage: !!extractOgImage(html),
      title: metaContent(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)</i) || [])[1] || '',
      description: metaContent(html, 'og:description') || metaContent(html, 'description'),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function metaContent(html, key) {
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i'));
  return m ? m[1] : '';
}

module.exports = { pickLeadSource, candidatesFromNotes };
