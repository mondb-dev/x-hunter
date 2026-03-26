#!/usr/bin/env node
/**
 * runner/capture_detection.js — "Am I being captured?"
 *
 * Mechanical analysis (no LLM). Scans ontology.json evidence_log entries
 * for the last 24h and computes source concentration metrics.
 *
 * Detects:
 * 1. Source dominance  — any single account driving >25% of today's evidence
 * 2. Cluster dominance — any single topic cluster driving >40% of evidence
 * 3. Pole skew         — >70% of evidence pushing in the same direction (left or right)
 * 4. Axis concentration — >50% of evidence landing on a single axis
 *
 * Writes: state/capture_state.json
 * Called once per day from daily.js reports().
 * Non-fatal: exits 0 on any error.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const ONTO_PATH = path.join(ROOT, 'state', 'ontology.json');
const TRUST_PATH = path.join(ROOT, 'state', 'trust_graph.json');
const OUT_PATH  = path.join(ROOT, 'state', 'capture_state.json');

const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * Extract @username from a tweet URL.
 * e.g. "https://x.com/SomeUser/status/123" → "someuser"
 */
function usernameFromUrl(url) {
  if (!url || typeof url !== 'string') return 'unknown';
  const m = url.match(/x\.com\/([A-Za-z0-9_]+)\//);
  return m ? m[1].toLowerCase() : 'unknown';
}

(function main() {
  try {
    const onto  = loadJson(ONTO_PATH);
    const trust = loadJson(TRUST_PATH);
    const axes  = onto?.axes || [];
    const now   = Date.now();
    const cutoff = new Date(now - TWENTY_FOUR_H).toISOString();

    // ── Collect today's evidence across all axes ──────────────────────────

    const recentEvidence = [];     // { source, username, axis_id, pole_alignment, trust_weight }
    const axisLabels = {};         // axis_id → label

    for (const axis of axes) {
      axisLabels[axis.id] = axis.label || axis.id;
      for (const e of (axis.evidence_log || [])) {
        if (!e.timestamp || e.timestamp < cutoff) continue;
        const username = usernameFromUrl(e.source);
        recentEvidence.push({
          source:         e.source || '',
          username,
          axis_id:        axis.id,
          pole_alignment: e.pole_alignment || 'neutral',
          trust_weight:   e.trust_weight ?? 1.0,
        });
      }
    }

    const totalEvidence = recentEvidence.length;

    if (totalEvidence === 0) {
      // No evidence today — write clean state
      const clean = {
        checked_at: new Date().toISOString(),
        evidence_24h: 0,
        alerts: [],
        source_concentration: {},
        axis_concentration: {},
        pole_balance: { left: 0, right: 0, neutral: 0 },
        status: 'clean',
        summary: 'No evidence collected in the last 24h — nothing to assess.',
      };
      fs.writeFileSync(OUT_PATH, JSON.stringify(clean, null, 2));
      console.log('[capture] no evidence in 24h — clean');
      return;
    }

    // ── 1. Source concentration ───────────────────────────────────────────

    const sourceCounts = {};
    for (const e of recentEvidence) {
      sourceCounts[e.username] = (sourceCounts[e.username] || 0) + 1;
    }

    // Sort by count desc
    const sourceRanked = Object.entries(sourceCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([username, count]) => ({
        username,
        count,
        share: parseFloat((count / totalEvidence).toFixed(3)),
      }));

    // ── 2. Axis concentration ─────────────────────────────────────────────

    const axisCounts = {};
    for (const e of recentEvidence) {
      axisCounts[e.axis_id] = (axisCounts[e.axis_id] || 0) + 1;
    }

    const axisRanked = Object.entries(axisCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([axis_id, count]) => ({
        axis_id,
        label: axisLabels[axis_id] || axis_id,
        count,
        share: parseFloat((count / totalEvidence).toFixed(3)),
      }));

    // ── 3. Pole balance ──────────────────────────────────────────────────

    let leftCount = 0, rightCount = 0, neutralCount = 0;
    for (const e of recentEvidence) {
      if (e.pole_alignment === 'left')  leftCount++;
      else if (e.pole_alignment === 'right') rightCount++;
      else neutralCount++;
    }

    const poleBalance = {
      left:    leftCount,
      right:   rightCount,
      neutral: neutralCount,
      left_share:  parseFloat((leftCount / totalEvidence).toFixed(3)),
      right_share: parseFloat((rightCount / totalEvidence).toFixed(3)),
    };

    // ── 4. Cluster concentration (from trust_graph) ──────────────────────

    const trustAccounts = trust?.accounts || {};
    const clusterCounts = {};
    for (const e of recentEvidence) {
      const acct = trustAccounts['@' + e.username] || trustAccounts[e.username] || {};
      const cluster = acct.cluster || 'unknown';
      clusterCounts[cluster] = (clusterCounts[cluster] || 0) + 1;
    }

    const clusterRanked = Object.entries(clusterCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([cluster, count]) => ({
        cluster,
        count,
        share: parseFloat((count / totalEvidence).toFixed(3)),
      }));

    // ── Generate alerts ──────────────────────────────────────────────────

    const alerts = [];

    // Source dominance: any source > 25%
    for (const s of sourceRanked) {
      if (s.share > 0.25) {
        alerts.push({
          type: 'source_dominance',
          severity: s.share > 0.40 ? 'high' : 'moderate',
          detail: `@${s.username} accounts for ${(s.share * 100).toFixed(0)}% of today's evidence (${s.count}/${totalEvidence})`,
          username: s.username,
          share: s.share,
        });
      }
    }

    // Cluster dominance: any cluster > 40%
    for (const c of clusterRanked) {
      if (c.share > 0.40 && c.cluster !== 'unknown') {
        alerts.push({
          type: 'cluster_dominance',
          severity: c.share > 0.60 ? 'high' : 'moderate',
          detail: `Cluster "${c.cluster}" accounts for ${(c.share * 100).toFixed(0)}% of today's evidence (${c.count}/${totalEvidence})`,
          cluster: c.cluster,
          share: c.share,
        });
      }
    }

    // Pole skew: >70% in one direction
    const maxPoleShare = Math.max(poleBalance.left_share, poleBalance.right_share);
    if (maxPoleShare > 0.70) {
      const dominant = poleBalance.left_share > poleBalance.right_share ? 'left' : 'right';
      alerts.push({
        type: 'pole_skew',
        severity: maxPoleShare > 0.85 ? 'high' : 'moderate',
        detail: `${(maxPoleShare * 100).toFixed(0)}% of evidence pushes "${dominant}" — risk of one-sided belief drift`,
        dominant_pole: dominant,
        share: maxPoleShare,
      });
    }

    // Axis concentration: >50% on single axis
    if (axisRanked.length > 0 && axisRanked[0].share > 0.50) {
      const a = axisRanked[0];
      alerts.push({
        type: 'axis_concentration',
        severity: a.share > 0.70 ? 'high' : 'moderate',
        detail: `"${a.label}" received ${(a.share * 100).toFixed(0)}% of today's evidence (${a.count}/${totalEvidence})`,
        axis_id: a.axis_id,
        share: a.share,
      });
    }

    // ── Determine overall status ─────────────────────────────────────────

    const highAlerts = alerts.filter(a => a.severity === 'high').length;
    const status = highAlerts > 0 ? 'captured'
                 : alerts.length > 0 ? 'warning'
                 : 'clean';

    // ── Build summary line (for prompt injection) ────────────────────────

    let summary;
    if (status === 'clean') {
      summary = `Evidence distribution looks healthy (${totalEvidence} entries across ${Object.keys(sourceCounts).length} sources, ${axisRanked.length} axes).`;
    } else {
      const alertLines = alerts.map(a => `[${a.severity.toUpperCase()}] ${a.detail}`);
      summary = `${alerts.length} capture alert(s) detected:\n` + alertLines.join('\n');
    }

    // ── Write state ──────────────────────────────────────────────────────

    const state = {
      checked_at: new Date().toISOString(),
      evidence_24h: totalEvidence,
      unique_sources: Object.keys(sourceCounts).length,
      status,
      alerts,
      summary,
      source_concentration: Object.fromEntries(sourceRanked.slice(0, 10).map(s => [s.username, s])),
      axis_concentration: Object.fromEntries(axisRanked.slice(0, 10).map(a => [a.axis_id, a])),
      cluster_concentration: Object.fromEntries(clusterRanked.slice(0, 5).map(c => [c.cluster, c])),
      pole_balance: poleBalance,
    };

    fs.writeFileSync(OUT_PATH, JSON.stringify(state, null, 2));
    console.log(`[capture] status=${status}, evidence=${totalEvidence}, sources=${Object.keys(sourceCounts).length}, alerts=${alerts.length}`);

  } catch (err) {
    console.error(`[capture] failed: ${err.message}`);
    process.exit(0); // non-fatal
  }
})();
