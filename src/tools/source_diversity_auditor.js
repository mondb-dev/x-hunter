'use strict';

const fs = require('fs');
const path = require('path');

const NAME = 'source_diversity_auditor';
const DESCRIPTION = 'Analyzes the diversity of sources contributing to belief updates over the last 24 hours.';
const VERSION = '1.0.0';

// Configurable threshold for flagging low-diversity updates
const SOURCE_DIVERSITY_THRESHOLD = 3;

/**
 * Calculates the Gini coefficient for an array of numbers (influence scores).
 * @param {number[]} values - An array of non-negative numbers.
 * @returns {number} The Gini coefficient, from 0 to 1.
 */
function calculateGini(values) {
  if (!values || values.length < 2) {
    return 0; // No inequality with 0 or 1 source
  }

  const n = values.length;
  const totalSum = values.reduce((acc, v) => acc + v, 0);

  if (totalSum === 0) {
    return 0; // No influence, no inequality
  }

  const sortedValues = [...values].sort((a, b) => a - b);

  let giniSum = 0;
  for (let i = 0; i < n; i++) {
    giniSum += (2 * (i + 1) - n - 1) * sortedValues[i];
  }

  return giniSum / (n * totalSum);
}

function run(args = {}) {
  const { dryRun = false } = args;
  const projectRoot = path.join(__dirname, '..', '..');
  const beliefHistoryPath = path.join(projectRoot, 'state', 'belief_history.jsonl');
  const ontologyPath = path.join(projectRoot, 'state', 'ontology.json');
  const reportDir = path.join(projectRoot, 'state', 'reports');
  const reportPath = path.join(reportDir, 'source_diversity_audit.json');

  console.log(`[${NAME}] Starting source diversity audit.`);

  if (!fs.existsSync(beliefHistoryPath)) {
    console.log(`[${NAME}] WARNING: state/belief_history.jsonl not found. Skipping audit.`);
    if (!dryRun) {
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({ alerts: [], statistics: [] }, null, 2));
    }
    return { status: 'skipped', reason: 'belief_history.jsonl not found' };
  }

  const ontologyData = fs.existsSync(ontologyPath)
    ? JSON.parse(fs.readFileSync(ontologyPath, 'utf8'))
    : { axes: [] };
  const axisLabels = ontologyData.axes.reduce((acc, axis) => {
    acc[axis.id] = axis.label;
    return acc;
  }, {});

  const historyContent = fs.readFileSync(beliefHistoryPath, 'utf8');
  const lines = historyContent.split('\n').filter(line => line.trim() !== '');

  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);

  const recentUpdates = lines
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(update => update && new Date(update.timestamp).getTime() >= twentyFourHoursAgo);

  if (recentUpdates.length === 0) {
    console.log(`[${NAME}] No recent belief updates found in the last 24 hours.`);
    if (!dryRun) {
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({ alerts: [], statistics: [] }, null, 2));
    }
    return { status: 'ok', message: 'No recent updates' };
  }

  const updatesByAxis = recentUpdates.reduce((acc, update) => {
    if (!acc[update.axis_id]) {
      acc[update.axis_id] = [];
    }
    acc[update.axis_id].push(update);
    return acc;
  }, {});

  const statistics = [];
  const alerts = [];

  for (const axisId in updatesByAxis) {
    const axisUpdates = updatesByAxis[axisId];
    const totalDelta = axisUpdates.reduce((sum, u) => sum + u.delta, 0);

    if (totalDelta === 0) continue;

    const sources = {};
    const sourceTypes = {};

    for (const update of axisUpdates) {
      const sourceId = update.source_id || 'unknown';
      const sourceType = update.source_type || 'unknown';
      const influence = Math.abs(update.delta);

      sources[sourceId] = (sources[sourceId] || 0) + influence;
      sourceTypes[sourceType] = (sourceTypes[sourceType] || 0) + 1;
    }

    const uniqueSources = Object.keys(sources);
    const influenceValues = Object.values(sources);
    const gini = calculateGini(influenceValues);

    const axisStat = {
      axis_id: axisId,
      axis_label: axisLabels[axisId] || 'Unknown Axis',
      total_delta: parseFloat(totalDelta.toFixed(4)),
      unique_source_count: uniqueSources.length,
      source_type_breakdown: sourceTypes,
      gini_coefficient: parseFloat(gini.toFixed(4)),
    };
    statistics.push(axisStat);

    if (uniqueSources.length < SOURCE_DIVERSITY_THRESHOLD) {
      alerts.push({
        axis_id: axisId,
        axis_label: axisLabels[axisId] || 'Unknown Axis',
        message: `Belief update was driven by only ${uniqueSources.length} unique source(s), which is below the threshold of ${SOURCE_DIVERSITY_THRESHOLD}.`,
        unique_source_count: uniqueSources.length,
        sources: uniqueSources,
      });
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    alerts,
    statistics,
  };

  if (dryRun) {
    console.log(`[${NAME}] DRY RUN: Would write the following report to ${reportPath}:`);
    console.log(JSON.stringify(report, null, 2));
  } else {
    try {
      if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true });
      }
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[${NAME}] Source diversity audit report saved to ${reportPath}.`);
    } catch (err) {
      console.error(`[${NAME}] Failed to write report: ${err.message}`);
      return { status: 'error', reason: err.message };
    }
  }

  return { status: 'ok', alerts: alerts.length, statistics: statistics.length };
}

module.exports = {
  name: NAME,
  description: DESCRIPTION,
  version: VERSION,
  run,
  capabilities: {
    read: ['state/belief_history.jsonl', 'state/ontology.json'],
    write: ['state/reports/source_diversity_audit.json'],
  },
};
