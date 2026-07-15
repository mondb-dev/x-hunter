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
 *   1. Extract candidate URLs + the note line each appears on.
 *   2. Score each by overlap between the post text and that line's words.
 *   3. In descending relevance, fetch each candidate and keep the first that has
 *      an og:image (this also drops X status URLs, whose logged-out fetch is a
 *      login wall with no usable image, and any dead links) — up to `maxProbe`.
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
 * @param {number} [opts.maxProbe=4]  max candidates to fetch-probe for an og:image
 * @param {number} [opts.timeoutMs=6000]  per-fetch timeout
 * @returns {Promise<{url:string, source:string}|null>}
 */
async function pickLeadSource(text, notes, { minScore = 2, maxProbe = 4, timeoutMs = 6000 } = {}) {
  const postWords = new Set(contentWords(text));
  if (!postWords.size) return null;

  const scored = candidatesFromNotes(notes)
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
    if (await hasOgImage(cand.url, timeoutMs)) {
      return { url: cand.url, source: hostLabel(cand.url) };
    }
  }
  return null;
}

/** True if the URL's HTML exposes an og:image / twitter:image (lightweight — HTML only, no image bytes). */
async function hasOgImage(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html')) return false;
    return !!extractOgImage(await res.text());
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pickLeadSource, candidatesFromNotes };
