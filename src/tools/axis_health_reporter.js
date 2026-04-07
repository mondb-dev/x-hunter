#!/usr/bin/env node
'use strict';
/**
 * src/tools/axis_health_reporter.js
 *
 * Scans belief axes for stagnation (high confidence, no score change in last N days)
 * and prints an Axis Health Report to stdout.
 *
 * Usage:
 *   node src/tools/axis_health_reporter.js [--days=3] [--min-confidence=0.80] [--dry-run]
 */

const { loadOntology, loadBeliefState, detectStagnantAxes } = require('../../lib/belief_system');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function getArg(name, defaultVal) {
  const match = args.find(a => a.startsWith('--' + name + '='));
  if (match) return parseFloat(match.split('=')[1]);
  return defaultVal;
}

const days          = getArg('days', 3);
const minConfidence = getArg('min-confidence', 0.80);

function run() {
  const ontology = loadOntology();
  const axes     = ontology.axes || [];

  console.log('[axis_health_reporter] Scanning ' + axes.length + ' axes (window=' + days + 'd, minConf=' + minConfidence + ')');

  const stagnant = detectStagnantAxes(ontology, days, minConfidence);

  if (stagnant.length === 0) {
    console.log('[axis_health_reporter] All high-confidence axes are active. No stagnation detected.');
    return { stagnant: [] };
  }

  console.log('\n=== AXIS HEALTH REPORT ===');
  console.log('Stagnant axes found: ' + stagnant.length);
  console.log('');

  for (const axis of stagnant) {
    console.log('Axis: ' + axis.id);
    console.log('  Label:             ' + axis.label);
    console.log('  Score:             ' + axis.score);
    console.log('  Confidence:        ' + axis.confidence);
    console.log('  Last updated:      ' + (axis.last_updated || 'never'));
    console.log('  Days since update: ' + axis.days_since_update);
    console.log('  Total evidence:    ' + axis.total_evidence);
    console.log('  Recent evidence:   ' + axis.recent_evidence + ' (last ' + days + 'd)');
    console.log('  Score range (win): ' + axis.score_range_window);
    if (axis.topics.length > 0) {
      console.log('  Topics:            ' + axis.topics.join(', '));
    }
    console.log('  Diagnosis:         ' + (axis.recent_evidence === 0
      ? 'No evidence gathered in window — check sourcing queries'
      : 'Evidence exists but score is flat — check processing logic'));
    console.log('');
  }

  if (dryRun) {
    console.log('[axis_health_reporter] Dry run — no state written.');
  }

  return { stagnant };
}

module.exports = { run };

if (require.main === module) {
  run();
}
