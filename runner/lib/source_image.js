'use strict';
/**
 * runner/lib/source_image.js — fetch a source's image so Sebastian can attach it
 * to a post and attribute it. Downloads the source URL's og:image to a temp file
 * (server-side fetch → no browser CORS limits). The temp file is deleted after
 * posting (caller uses cleanup()).
 *
 *   fetchSourceImage(sourceUrl) -> { path, imageUrl, source } | null
 *   attribution(source)         -> "📷 via <source>"
 *   cleanup(path)               -> unlink temp file (never throws)
 *
 * Node built-ins + global fetch (Node 18+). No deps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh) SebastianHunter/1.0';

function extractOgImage(html) {
  const m =
    html.match(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/** Best-effort host label for attribution when no explicit source name is given. */
function hostLabel(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

/**
 * @param {string} sourceUrl  the page whose image to copy
 * @param {object} [opts]
 * @param {string} [opts.source]  attribution label (defaults to the host)
 * @param {number} [opts.maxBytes]  skip images larger than this (default 5MB — X/LI limit-safe)
 * @returns {Promise<{path:string, imageUrl:string, source:string}|null>}
 */
async function fetchSourceImage(sourceUrl, { source, maxBytes = 5 * 1024 * 1024 } = {}) {
  try {
    const pageRes = await fetch(sourceUrl, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();
    let imageUrl = extractOgImage(html);
    if (!imageUrl) return null;
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    else if (imageUrl.startsWith('/')) { try { imageUrl = new URL(imageUrl, sourceUrl).href; } catch {} }

    const imgRes = await fetch(imageUrl, { headers: { 'user-agent': UA } });
    if (!imgRes.ok) return null;
    const ct = (imgRes.headers.get('content-type') || '').toLowerCase();
    if (!/image\//.test(ct)) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;

    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg';
    const p = path.join(os.tmpdir(), `srcimg_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`);
    fs.writeFileSync(p, buf);
    return { path: p, imageUrl, source: source || hostLabel(sourceUrl) };
  } catch { return null; }
}

function attribution(source) { return `📷 via ${source}`; }

function cleanup(p) { try { if (p) fs.unlinkSync(p); } catch { /* already gone */ } }

module.exports = { fetchSourceImage, attribution, cleanup, extractOgImage, hostLabel };
