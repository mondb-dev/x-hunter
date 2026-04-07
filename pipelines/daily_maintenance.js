#!/usr/bin/env node
'use strict';
/**
 * pipelines/daily_maintenance.js
 *
 * Daily maintenance pipeline. Runs reports and archives state.
 *   1. Axis Health Report — detects stagnant high-confidence belief axes
 *   2. Belief Dynamics Report - calculates and records belief changes
 *   3. Archives ontology for historical comparison
 *
 * Usage:
 *   node pipelines/daily_maintenance.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { run: runAxisHealthReport } = require('../src/tools/axis_health_reporter');
const { run: runBeliefReporter } = require('../src/tools/belief_reporter');

const dryRun = process.argv.includes('--dry-run');

function log(msg) {
  console.log('[daily_maintenance] ' + msg);
}

function archiveOntology() {
  if (dryRun) {
    log('Skipping ontology archive in dry run mode.');
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const projectRoot = path.join(__dirname, '..');
  const ontologyPath = path.join(projectRoot, 'state', 'ontology.json');
  const archiveDir = path.join(projectRoot, 'state', 'archive');
  const archivePath = path.join(archiveDir, `ontology_${todayStr}.json`);

  try {
    if (!fs.existsSync(ontologyPath)) {
      log('WARNING: state/ontology.json not found. Skipping archival.');
      return;
    }
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    log(`Archiving current ontology to ${archivePath}...`);
    fs.copyFileSync(ontologyPath, archivePath);
    log('Archival complete.');
  } catch (err) {
    console.error(`Failed to archive ontology: ${err.message}`);
    // Do not exit, as reporting might still be useful
  }
}

function main() {
  log('Starting daily maintenance' + (dryRun ? ' (dry run)' : '') + '...');

  try {
    log('Running axis health report...');
    // Assuming runAxisHealthReport handles its own dry run logic if needed
    runAxisHealthReport();
    log('Axis health report complete.');

    log('Running belief dynamics report...');
    runBeliefReporter({ dryRun });
    log('Belief dynamics report complete.');

  } catch (err) {
    console.error('Daily maintenance failed during reporting: ' + err.message);
    process.exit(1);
  }

  // Archive the ontology at the end of the process for the next day's run
  archiveOntology();

  log('Daily maintenance complete.');
}

main();
