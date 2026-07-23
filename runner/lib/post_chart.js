'use strict';
/**
 * runner/lib/post_chart.js — original data charts for outbound posts.
 *
 * WHY this exists: the alternative "media" for a post is an og:image scraped from
 * a news article, which is often a generic outlet card or headshot, adds nothing,
 * and republishes someone else's photography under a credit line that is a norm,
 * not a licence. A chart of the numbers Sebastian is already citing is his own
 * artifact: licence-clean, distinctive in a feed, and it demonstrates the analyst
 * position instead of asserting it.
 *
 *   planChart(postText, packText)  → spec | null   (LLM proposes; numbers verified)
 *   renderChart(spec)              → { path } | null
 *   cleanup(path)                  → void
 *
 * FABRICATION GUARD: a chart is a factual claim with a strong veneer of authority,
 * so every value in the spec must appear verbatim in the post or its source
 * material. A proposed number that is not in the text is treated as invented and
 * the whole chart is dropped — this is a mechanical check, not a request to the
 * model to behave.
 *
 * RASTERISATION: LinkedIn takes bitmaps, chart_svg emits SVG. qlmanage (macOS
 * QuickLook, always present) renders to a SQUARE of the longest side, so the SVG
 * is wrapped square — content genuinely centred — and then centre-cropped to the
 * content band. A non-square wrapper letterboxes unpredictably and clips. Its SVG
 * font support is limited and falls back to a serif face regardless of the stack;
 * that is cosmetic and left alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const chart = require('./chart_svg');

const SIDE = 1200;   // qlmanage renders longest side to this
const PAD  = 70;     // horizontal breathing room inside the square

/** Numbers actually present in the material, as a lookup of normalised strings. */
function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d[\d,]*\.?\d*/g)) {
    const n = Number(String(m[0]).replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(String(n));
  }
  return out;
}

/**
 * Ask for a chart spec, then VERIFY it against the material.
 * Returns { type:'bar'|'line', title, labels, values|series, source } or null.
 */
async function planChart(postText, packText, { tag = 'chart' } = {}) {
  const material = `${postText || ''}\n\n${packText || ''}`;
  const { reason } = require('./compose');
  let raw;
  try {
    raw = await reason(
      `You are deciding whether a post should carry a DATA CHART.\n\n` +
      `POST:\n"""\n${String(postText || '').slice(0, 1500)}\n"""\n\n` +
      `SOURCE MATERIAL:\n"""\n${String(packText || '').slice(0, 3000)}\n"""\n\n` +
      `A chart is worth making ONLY if the material contains at least 3 real, comparable figures ` +
      `on the same measure (amounts, counts, percentages over categories or time). Do NOT invent, ` +
      `estimate, round or extrapolate any number — every value must appear literally in the text ` +
      `above. If there is no such dataset, say so; that is the common answer.\n\n` +
      `Output ONLY JSON:\n` +
      `{"worth_charting": false, "why": "one line"}\n` +
      `OR {"worth_charting": true, "type": "bar", "title": "short, states the measure and unit", ` +
      `"labels": ["..."], "values": [1,2,3], "source": "outlet or body the figures come from"}`,
      { maxTokens: 400, tag: `${tag}:plan` }
    );
  } catch (e) { return null; }

  let spec;
  try {
    const m = String(raw).replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
    spec = m ? JSON.parse(m[0]) : null;
  } catch { return null; }
  if (!spec || !spec.worth_charting) return null;

  const labels = Array.isArray(spec.labels) ? spec.labels.map(String) : [];
  const values = Array.isArray(spec.values) ? spec.values.map(Number) : [];
  if (labels.length < 3 || labels.length !== values.length) return null;
  if (values.some((v) => !Number.isFinite(v))) return null;

  // Fabrication guard — every plotted value must exist in the material.
  const present = numbersIn(material);
  const invented = values.filter((v) => !present.has(String(v)));
  if (invented.length) {
    console.log(`[post_chart] rejected — value(s) not in source material: ${invented.join(', ')}`);
    return null;
  }

  return { type: spec.type === 'line' ? 'line' : 'bar', title: String(spec.title || '').slice(0, 90), labels, values, source: String(spec.source || '').slice(0, 60) };
}

/** Render a spec to a PNG on disk. Returns { path } or null. */
function renderChart(spec) {
  if (!spec || !Array.isArray(spec.labels) || !spec.labels.length) return null;
  let inner;
  try {
    inner = spec.type === 'line'
      ? chart.line({ title: spec.title, labels: spec.labels, series: [{ name: spec.title || 'value', values: spec.values }] })
      : chart.bar({ title: spec.title, labels: spec.labels, values: spec.values });
  } catch (e) { console.log(`[post_chart] chart_svg failed: ${e.message}`); return null; }

  const vb = inner.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) return null;
  const iw = Number(vb[1]), ih = Number(vb[2]);
  const body = inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const scale = (SIDE - 2 * PAD) / iw;
  const contentH = ih * scale;
  const ty = (SIDE - contentH) / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE}" height="${SIDE}" viewBox="0 0 ${SIDE} ${SIDE}">` +
    `<rect width="${SIDE}" height="${SIDE}" fill="#0d0f10"/>` +
    `<g transform="translate(${PAD},${ty}) scale(${scale})">${body}</g></svg>`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-'));
  const svgPath = path.join(dir, 'c.svg');
  const rawPng = path.join(dir, 'c.svg.png');
  const outPng = path.join(dir, 'chart.png');
  try {
    fs.writeFileSync(svgPath, svg);
    execFileSync('qlmanage', ['-t', '-s', String(SIDE), '-o', dir, svgPath], { stdio: 'ignore', timeout: 30_000 });
    if (!fs.existsSync(rawPng)) { cleanup(dir); return null; }
    const cropH = Math.round(contentH + 140);   // content band + margin
    execFileSync('sips', ['-c', String(cropH), String(SIDE), rawPng, '--out', outPng], { stdio: 'ignore', timeout: 30_000 });
    if (!fs.existsSync(outPng)) { cleanup(dir); return null; }
    return { path: outPng, dir };
  } catch (e) {
    console.log(`[post_chart] rasterise failed: ${e.message}`);
    cleanup(dir);
    return null;
  }
}

/** Remove a rendered chart (pass the .dir from renderChart, or a file path). */
function cleanup(p) {
  try {
    if (!p) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch { /* already gone */ }
}

module.exports = { planChart, renderChart, cleanup, numbersIn };
