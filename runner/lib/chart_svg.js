'use strict';

// Pure SVG chart generation — no dependencies.
// All charts use the project dark theme: bg #0d0f10, muted #8b99aa, accent amber/blue.

const COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Multi-series line chart.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string[]} opts.labels  — x-axis labels (dates or strings)
 * @param {{ name: string, values: number[] }[]} opts.series
 * @param {number} [opts.yMin=-1]
 * @param {number} [opts.yMax=1]
 * @param {number} [opts.W=860]
 * @param {number} [opts.H=320]
 */
function line({ title = '', labels, series, yMin = -1, yMax = 1, W = 860, H = 320 }) {
  const ML = 42, MR = 18, MT = 28, MB = 44;
  const cW = W - ML - MR;
  const cH = H - MT - MB;
  const n = labels.length;

  function xp(i) { return ML + (n > 1 ? (i / (n - 1)) * cW : cW / 2); }
  function yp(v) { return MT + (1 - (v - yMin) / (yMax - yMin)) * cH; }

  const yTicks = [];
  const range = yMax - yMin;
  const step = range <= 1 ? 0.25 : range <= 2 ? 0.5 : 1;
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 0.001; v = Math.round((v + step) * 1000) / 1000) {
    yTicks.push(v);
  }

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="background:#0d0f10;font-family:ui-monospace,monospace">`;

  // Title
  if (title) {
    s += `<text x="${ML}" y="16" font-size="9" fill="#8b99aa" letter-spacing="0.08em" text-anchor="start">${esc(title.toUpperCase())}</text>`;
  }

  // Y grid + labels
  for (const v of yTicks) {
    const y = yp(v);
    const isZero = Math.abs(v) < 0.001;
    s += `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${(ML + cW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${isZero ? '#252830' : '#191b1e'}" stroke-width="${isZero ? 1.2 : 0.7}" stroke-dasharray="${isZero ? '4 3' : '2 4'}"/>`;
    s += `<text x="${ML - 4}" y="${(y + 3).toFixed(1)}" font-size="7" fill="#4a5568" text-anchor="end">${v >= 0 ? '+' : ''}${v.toFixed(2)}</text>`;
  }

  // X labels — sample to avoid overlap
  const xStep = Math.max(1, Math.ceil(n / 9));
  labels.forEach((lbl, i) => {
    if (i % xStep !== 0 && i !== n - 1) return;
    const x = xp(i);
    // Show MM-DD only
    const short = String(lbl).length >= 10 ? String(lbl).slice(5) : String(lbl);
    s += `<text x="${x.toFixed(1)}" y="${(MT + cH + 13).toFixed(1)}" font-size="7" fill="#4a5568" text-anchor="middle">${esc(short)}</text>`;
  });

  // Frame bottom line
  s += `<line x1="${ML}" y1="${(MT + cH).toFixed(1)}" x2="${(ML + cW).toFixed(1)}" y2="${(MT + cH).toFixed(1)}" stroke="#252830" stroke-width="0.8"/>`;

  // Series
  series.forEach((sr, si) => {
    const color = COLORS[si % COLORS.length];
    const pts = sr.values.map((v, i) => `${xp(i).toFixed(1)},${yp(v).toFixed(1)}`).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity="0.88"/>`;
    // Terminal dot
    const last = sr.values[sr.values.length - 1];
    s += `<circle cx="${xp(sr.values.length - 1).toFixed(1)}" cy="${yp(last).toFixed(1)}" r="2.8" fill="${color}"/>`;
  });

  // Legend — bottom, below x-axis labels
  const legendY = MT + cH + 30;
  const colW = Math.min(200, cW / series.length);
  series.forEach((sr, si) => {
    const color = COLORS[si % COLORS.length];
    const lx = ML + si * colW;
    s += `<circle cx="${(lx + 5).toFixed(1)}" cy="${legendY.toFixed(1)}" r="3" fill="${color}" opacity="0.9"/>`;
    const label = sr.name.length > 22 ? sr.name.slice(0, 21) + '…' : sr.name;
    s += `<text x="${(lx + 11).toFixed(1)}" y="${(legendY + 3).toFixed(1)}" font-size="7.5" fill="#8b99aa" opacity="0.85">${esc(label)}</text>`;
  });

  s += '</svg>';
  return s;
}

/**
 * Horizontal bar chart.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string[]} opts.labels
 * @param {number[]} opts.values
 * @param {string[]} [opts.colors]
 * @param {number} [opts.W=700]
 * @param {number} [opts.rowH=22]
 */
function bar({ title = '', labels, values, colors, W = 700, rowH = 22 }) {
  const ML = 210, MR = 60, MT = 28, MB = 16;
  const H = MT + labels.length * rowH + MB;
  const maxV = Math.max(...values, 1);

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="background:#0d0f10;font-family:ui-monospace,monospace">`;

  if (title) {
    s += `<text x="${ML}" y="17" font-size="9" fill="#8b99aa" letter-spacing="0.08em">${esc(title.toUpperCase())}</text>`;
  }

  labels.forEach((lbl, i) => {
    const y = MT + i * rowH;
    const barW = ((values[i] / maxV) * (W - ML - MR));
    const color = colors ? colors[i % colors.length] : COLORS[i % COLORS.length];
    const label = lbl.length > 28 ? lbl.slice(0, 27) + '…' : lbl;

    // Row bg
    if (i % 2 === 0) {
      s += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#0f1113" opacity="0.6"/>`;
    }
    // Label
    s += `<text x="${ML - 6}" y="${(y + rowH / 2 + 3.5).toFixed(1)}" font-size="8.5" fill="#8b99aa" text-anchor="end">${esc(label)}</text>`;
    // Bar
    s += `<rect x="${ML}" y="${(y + 3).toFixed(1)}" width="${barW.toFixed(1)}" height="${rowH - 6}" fill="${color}" opacity="0.75" rx="2"/>`;
    // Value
    s += `<text x="${(ML + barW + 5).toFixed(1)}" y="${(y + rowH / 2 + 3.5).toFixed(1)}" font-size="8" fill="#8b99aa">${values[i].toLocaleString()}</text>`;
  });

  s += '</svg>';
  return s;
}

/**
 * Radar / spider chart.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string[]} opts.labels     — axis names (one per spoke)
 * @param {number[]} opts.values     — values 0..1 (normalized)
 * @param {number} [opts.W=500]
 * @param {number} [opts.H=500]
 */
function radar({ title = '', labels, values, W = 500, H = 500 }) {
  const cx = W / 2, cy = H / 2 + 10;
  const R = Math.min(W, H) * 0.38;
  const n = labels.length;

  function spoke(i, r) {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="background:#0d0f10;font-family:ui-monospace,monospace">`;

  if (title) {
    s += `<text x="${W / 2}" y="16" font-size="9" fill="#8b99aa" letter-spacing="0.08em" text-anchor="middle">${esc(title.toUpperCase())}</text>`;
  }

  // Rings
  for (const ring of [0.25, 0.5, 0.75, 1.0]) {
    const pts = Array.from({ length: n }, (_, i) => {
      const p = spoke(i, R * ring);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(' ');
    s += `<polygon points="${pts}" fill="none" stroke="#1e2022" stroke-width="0.8"/>`;
  }

  // Spoke lines
  for (let i = 0; i < n; i++) {
    const tip = spoke(i, R);
    s += `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${tip.x.toFixed(1)}" y2="${tip.y.toFixed(1)}" stroke="#1e2022" stroke-width="0.8"/>`;
  }

  // Value polygon
  const valPts = values.map((v, i) => {
    const p = spoke(i, R * Math.max(0, Math.min(1, v)));
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(' ');
  s += `<polygon points="${valPts}" fill="#f59e0b" fill-opacity="0.18" stroke="#f59e0b" stroke-width="1.5" stroke-opacity="0.8"/>`;

  // Dots + labels
  for (let i = 0; i < n; i++) {
    const dot = spoke(i, R * Math.max(0, Math.min(1, values[i])));
    s += `<circle cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="3" fill="#f59e0b"/>`;

    const tip = spoke(i, R * 1.15);
    const label = labels[i].length > 20 ? labels[i].slice(0, 19) + '…' : labels[i];
    const anchor = tip.x < cx - 5 ? 'end' : tip.x > cx + 5 ? 'start' : 'middle';
    s += `<text x="${tip.x.toFixed(1)}" y="${(tip.y + 3).toFixed(1)}" font-size="7.5" fill="#8b99aa" text-anchor="${anchor}">${esc(label)}</text>`;
  }

  s += '</svg>';
  return s;
}

module.exports = { line, bar, radar, COLORS };
