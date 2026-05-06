#!/usr/bin/env node
'use strict';

// Generates chart data snapshots for the web app.
// Output: web/public/data/belief_drift.json + evidence_dist.json + posting_calendar.json
// Run daily (wired into daily block in orchestrator).

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const STATE    = path.join(ROOT, 'state');
const DATA_OUT = path.join(ROOT, 'web/public/data');

fs.mkdirSync(DATA_OUT, { recursive: true });

// ── 1. Belief drift (weekly-sampled score per top axis) ───────────────────────

const ontology = JSON.parse(fs.readFileSync(path.join(STATE, 'ontology.json'), 'utf-8'));
const allAxes  = ontology.axes || [];

// Top 8 axes by evidence count with confidence > 0.4
const topAxes = allAxes
  .filter(a => a.confidence > 0.4 && (a.evidence_log || []).length >= 20)
  .sort((a, b) => (b.evidence_log || []).length - (a.evidence_log || []).length)
  .slice(0, 8);

function isoWeekMonday(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function buildWeeklyDrift(axis) {
  const ev = (axis.evidence_log || [])
    .filter(e => e.timestamp && e.score_after !== undefined)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (!ev.length) return [];

  const firstWeek = isoWeekMonday(ev[0].timestamp);
  const lastWeek  = isoWeekMonday(new Date().toISOString());

  const weeks = [];
  let cursor = new Date(firstWeek + 'T00:00:00Z');
  const end  = new Date(lastWeek  + 'T00:00:00Z');
  while (cursor <= end) {
    weeks.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 7 * 86400000);
  }

  let lastScore = ev[0].score_after;
  const samples = weeks.map(weekStart => {
    const weekEnd = new Date(new Date(weekStart).getTime() + 7 * 86400000 - 1).toISOString();
    // find last evidence in this week
    for (let i = ev.length - 1; i >= 0; i--) {
      if (ev[i].timestamp >= weekStart && ev[i].timestamp <= weekEnd) {
        lastScore = ev[i].score_after;
        break;
      }
    }
    return { week: weekStart, score: Math.round(lastScore * 1000) / 1000 };
  });

  return samples;
}

const driftData = {
  generated_at: new Date().toISOString(),
  axes: topAxes.map(a => ({
    id: a.id,
    label: a.label,
    current_score: a.score,
    confidence: a.confidence,
    evidence_count: (a.evidence_log || []).length,
    samples: buildWeeklyDrift(a),
  })),
};

fs.writeFileSync(path.join(DATA_OUT, 'belief_drift.json'), JSON.stringify(driftData, null, 2));
console.log(`[chart_snapshot] belief_drift.json: ${driftData.axes.length} axes`);

// ── 2. Evidence distribution (all axes, sorted by count) ─────────────────────

const evDist = {
  generated_at: new Date().toISOString(),
  axes: allAxes
    .filter(a => (a.evidence_log || []).length > 0)
    .sort((a, b) => (b.evidence_log || []).length - (a.evidence_log || []).length)
    .map(a => ({
      id: a.id,
      label: a.label,
      count: (a.evidence_log || []).length,
      score: a.score,
      confidence: a.confidence,
    })),
};

fs.writeFileSync(path.join(DATA_OUT, 'evidence_dist.json'), JSON.stringify(evDist, null, 2));
console.log(`[chart_snapshot] evidence_dist.json: ${evDist.axes.length} axes`);

// ── 3. Posting calendar (daily post counts) ───────────────────────────────────

let posts = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(STATE, 'posts_log.json'), 'utf-8'));
  posts = Array.isArray(raw) ? raw : (raw.posts || Object.values(raw));
} catch {}

const calMap = {};
for (const p of posts) {
  const date = p.date || (p.posted_at ? p.posted_at.slice(0, 10) : null);
  if (date) calMap[date] = (calMap[date] || 0) + 1;
}

const calData = {
  generated_at: new Date().toISOString(),
  days: Object.entries(calMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count })),
};

fs.writeFileSync(path.join(DATA_OUT, 'posting_calendar.json'), JSON.stringify(calData, null, 2));
console.log(`[chart_snapshot] posting_calendar.json: ${calData.days.length} days`);
