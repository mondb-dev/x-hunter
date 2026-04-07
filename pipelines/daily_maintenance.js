#!/usr/bin/env node
'use strict';
/**
 * pipelines/daily_maintenance.js
 *
 * Daily maintenance pipeline. Currently runs:
 *   1. Axis Health Report — detects stagnant high-confidence belief axes
 *
 * Usage:
 *   node pipelines/daily_maintenance.js [--dry-run]
 */

const { run: runAxisHealthReport } = require('../src/tools/axis_health_reporter');

const dryRun = process.argv.includes('--dry-run');

function log(msg) {
  console.log('[daily_maintenance] ' + msg);
}

function main() {
  log('Starting daily maintenance' + (dryRun ? ' (dry run)' : '') + '...');

  try {
    log('Running axis health report...');
    runAxisHealthReport();
    log('Axis health report complete.');
  } catch (err) {
    console.error('Daily maintenance failed: ' + err.message);
    process.exit(1);
  }

  log('Daily maintenance complete.');
}

main();
