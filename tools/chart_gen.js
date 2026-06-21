'use strict';

const name = 'chart_gen';
const description =
  'Generate an SVG chart from belief axis data. Supports line (drift over time), bar (evidence distribution), radar (confidence profile). Writes to web/public/images/charts/. Returns the relative URL to embed in articles or journals.';

const capabilities = {
  read: ['state/ontology.json', 'state/posts_log.json'],
  write: [],
  network: true, // network:true so it runs outside bubblewrap and can write to web/public/
};

const parameters = {
  properties: {
    type: { type: 'string', enum: ['line', 'bar', 'radar'], description: 'Chart type' },
    title: { type: 'string', description: 'Chart title' },
    filename: { type: 'string', description: 'Output filename without extension (e.g. belief_drift_2026-05-06)' },
    axis_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'For line/radar: axis IDs to include. Omit to auto-select top axes by evidence count.',
    },
    top_n: { type: 'number', description: 'Auto-select top N axes by evidence count (default 8)' },
    days: { type: 'number', description: 'For line chart: how many days back to plot (default 30)' },
  },
  required: ['type', 'filename'],
};

function execute({ type, title, filename, axis_ids, top_n = 8, days = 30 }) {
  const fs = require('fs');
  const path = require('path');

  const ROOT = path.resolve(__dirname, '..');
  const { line, bar, radar } = require(path.join(ROOT, 'runner/lib/chart_svg'));

  const ontology = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/ontology.json'), 'utf-8'));
  const allAxes = ontology.axes || [];

  const outDir = path.join(ROOT, 'web/public/images/charts');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, filename.replace(/\.svg$/, '') + '.svg');
  const urlPath = '/images/charts/' + filename.replace(/\.svg$/, '') + '.svg';

  let svg = '';

  if (type === 'line') {
    // Select axes
    let axes = allAxes.filter(a => (a.evidence_log || []).length > 0);
    if (axis_ids && axis_ids.length > 0) {
      axes = axes.filter(a => axis_ids.includes(a.id));
    } else {
      axes = axes.sort((a, b) => (b.evidence_log || []).length - (a.evidence_log || []).length).slice(0, top_n);
    }

    // Build weekly samples over last `days` days
    const now = Date.now();
    const cutoff = now - days * 86400000;

    // Get all dates in range (weekly)
    const weekMs = 7 * 86400000;
    const startMs = Math.max(cutoff, Math.min(...axes.map(a => {
      const ev = (a.evidence_log || []).filter(e => e.timestamp);
      return ev.length ? new Date(ev[0].timestamp).getTime() : now;
    })));

    const weeks = [];
    for (let t = startMs; t <= now; t += weekMs) {
      weeks.push(new Date(t).toISOString().slice(0, 10));
    }
    if (weeks[weeks.length - 1] !== new Date().toISOString().slice(0, 10)) {
      weeks.push(new Date().toISOString().slice(0, 10));
    }

    const series = axes.map(a => {
      const ev = (a.evidence_log || [])
        .filter(e => e.timestamp && e.score_after !== undefined)
        .sort((x, y) => x.timestamp.localeCompare(y.timestamp));

      let lastScore = a.score;
      const values = weeks.map(weekDate => {
        // last score_after on or before this week date
        const weekEnd = weekDate + 'T23:59:59Z';
        for (let i = ev.length - 1; i >= 0; i--) {
          if (ev[i].timestamp <= weekEnd) {
            lastScore = ev[i].score_after;
            break;
          }
        }
        return lastScore;
      });

      const label = a.label.replace(/^(The |A |An )/, '');
      return { name: label, values };
    });

    svg = line({
      title: title || `Belief Drift — last ${days} days`,
      labels: weeks,
      series,
      yMin: -1,
      yMax: 1,
    });

  } else if (type === 'bar') {
    let axes = allAxes.filter(a => (a.evidence_log || []).length > 0);
    if (axis_ids && axis_ids.length > 0) {
      axes = axes.filter(a => axis_ids.includes(a.id));
    }
    axes = axes.sort((a, b) => (b.evidence_log || []).length - (a.evidence_log || []).length).slice(0, top_n * 2);

    const labels = axes.map(a => {
      const l = a.label.replace(/^(The |A |An )/, '');
      return l.length > 30 ? l.slice(0, 29) + '…' : l;
    });
    const values = axes.map(a => (a.evidence_log || []).length);

    svg = bar({
      title: title || 'Evidence by Axis',
      labels,
      values,
    });

  } else if (type === 'radar') {
    let axes = allAxes.filter(a => a.confidence > 0.1);
    if (axis_ids && axis_ids.length > 0) {
      axes = axes.filter(a => axis_ids.includes(a.id));
    } else {
      axes = axes.sort((a, b) => b.confidence - a.confidence).slice(0, Math.min(top_n, 12));
    }

    const labels = axes.map(a => a.label.replace(/^(The |A |An )/, '').split(' ').slice(0, 3).join(' '));
    // Normalize: score is -1..1, map to 0..1 where 0.5 = neutral
    const values = axes.map(a => (a.score + 1) / 2);

    svg = radar({
      title: title || 'Belief Profile',
      labels,
      values,
    });
  }

  if (!svg) return { error: `Unknown chart type: ${type}` };

  fs.writeFileSync(outPath, svg, 'utf-8');

  return {
    path: outPath,
    url: urlPath,
    html: `![${title || type + ' chart'}](${urlPath})`,
    axes_included: (type === 'line' || type === 'radar')
      ? allAxes.filter(a => axis_ids ? axis_ids.includes(a.id) : true).slice(0, top_n).map(a => a.id)
      : undefined,
  };
}

module.exports = { name, description, capabilities, parameters, execute };
