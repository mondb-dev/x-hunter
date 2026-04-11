#!/usr/bin/env node
'use strict';
/**
 * runner/generate_trajectory.js — per-axis trajectory over 1d / 3d / 7d windows
 *
 * Reads:  state/ontology.json (current axes)
 *         state/snapshots/YYYY-MM-DD.json (historical snapshots)
 * Writes: state/trajectory_summary.json  — structured data
 *         state/trajectory_summary.txt   — injected into browse context
 *
 * Called from post_browse.js every 6 cycles (~2h) via stamp file.
 * Non-fatal; swallows errors.
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const STATE    = path.join(ROOT, 'state');
const ONTO     = path.join(STATE, 'ontology.json');
const SNAPS    = path.join(STATE, 'snapshots');
const OUT_JSON = path.join(STATE, 'trajectory_summary.json');
const OUT_TXT  = path.join(STATE, 'trajectory_summary.txt');

const WINDOWS = [
  { label: '1d', days: 1 },
  { label: '3d', days: 3 },
  { label: '7d', days: 7 },
];
const MOVE_THRESHOLD = 0.02; // minimum delta to report as movement

function dateStrDaysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function loadSnapshot(dateStr) {
  const p = path.join(SNAPS, `${dateStr}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function dirSymbol(delta) {
  if (Math.abs(delta) < MOVE_THRESHOLD) return '→';
  return delta > 0 ? '↗' : '↘';
}

function run() {
  const onto = JSON.parse(fs.readFileSync(ONTO, 'utf-8'));
  const axes = onto.axes || [];

  // Load historical snapshots
  const snaps = {};
  for (const w of WINDOWS) {
    snaps[w.label] = loadSnapshot(dateStrDaysAgo(w.days));
  }

  // Build per-axis lookup from each snapshot
  const snapMaps = {};
  for (const [label, snap] of Object.entries(snaps)) {
    snapMaps[label] = {};
    for (const ax of (snap?.axes || [])) {
      snapMaps[label][ax.id] = ax;
    }
  }

  const axisData = {};
  for (const ax of axes) {
    const entry = {
      current: { score: ax.score ?? 0, confidence: ax.confidence ?? 0 },
    };
    for (const w of WINDOWS) {
      const prev = snapMaps[w.label]?.[ax.id];
      if (!prev) {
        entry[w.label] = null;
      } else {
        const dScore = (ax.score ?? 0) - (prev.score ?? 0);
        const dConf  = (ax.confidence ?? 0) - (prev.confidence ?? 0);
        entry[w.label] = {
          score_delta: parseFloat(dScore.toFixed(4)),
          conf_delta:  parseFloat(dConf.toFixed(4)),
          direction:   dirSymbol(dScore),
        };
      }
    }
    axisData[ax.id] = entry;
  }

  // Build human-readable summary for browse context
  // Show axes with notable movement (any window > threshold), sorted by max abs delta
  const notable = axes
    .map(ax => {
      const d = axisData[ax.id];
      const maxDelta = WINDOWS.reduce((m, w) => {
        const wd = d[w.label];
        return wd ? Math.max(m, Math.abs(wd.score_delta)) : m;
      }, 0);
      return { ax, d, maxDelta };
    })
    .filter(x => x.maxDelta >= MOVE_THRESHOLD)
    .sort((a, b) => b.maxDelta - a.maxDelta)
    .slice(0, 8);

  const lines = ['## Axis trajectory (score deltas)'];
  if (notable.length === 0) {
    lines.push('No significant axis movement in the last 7 days.');
  } else {
    for (const { ax, d } of notable) {
      const parts = WINDOWS
        .map(w => {
          const wd = d[w.label];
          if (!wd) return null;
          const sign = wd.score_delta >= 0 ? '+' : '';
          return `${w.label}: ${wd.direction}${sign}${wd.score_delta.toFixed(3)}`;
        })
        .filter(Boolean)
        .join('  ');
      lines.push(`  ${ax.label}: ${parts}`);
    }
  }

  // Momentum alerts: axis moving same direction for 3d AND 7d
  const momentum = axes.filter(ax => {
    const d = axisData[ax.id];
    const d3 = d['3d'], d7 = d['7d'];
    if (!d3 || !d7) return false;
    return Math.sign(d3.score_delta) === Math.sign(d7.score_delta) &&
           Math.abs(d7.score_delta) >= 0.05;
  });

  if (momentum.length) {
    lines.push('');
    lines.push('Sustained momentum (same direction 3d + 7d):');
    for (const ax of momentum) {
      const d = axisData[ax.id];
      lines.push(`  ${d['7d'].direction} ${ax.label} (7d: ${d['7d'].score_delta > 0 ? '+' : ''}${d['7d'].score_delta.toFixed(3)})`);
    }
  }

  const txt = lines.join('\n');

  const summary = {
    generated_at: new Date().toISOString(),
    windows:      WINDOWS.map(w => w.label),
    move_threshold: MOVE_THRESHOLD,
    axes:         axisData,
    notable_count: notable.length,
    momentum_axes: momentum.map(a => a.id),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
  fs.writeFileSync(OUT_TXT,  txt);
  console.log(`[trajectory] written: ${notable.length} notable axes, ${momentum.length} momentum`);
}

try { run(); } catch (err) { console.error(`[trajectory] error: ${err.message}`); }
