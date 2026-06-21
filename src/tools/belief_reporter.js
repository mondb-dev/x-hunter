'use strict';

const fs = require('fs');
const path = require('path');

const NAME = 'belief_reporter';
const DESCRIPTION = 'Generates a daily belief dynamics report by comparing current and previous ontology states.';

const CAPABILITIES = {
  read: ['state/ontology.json', 'state/archive/**'],
  write: ['reports/belief_dynamics_*.json'],
  call_tools: [],
};

/**
 * The core logic for the belief reporter.
 * @param {object} args - Tool arguments (currently unused).
 * @param {object} context - The execution context.
 * @param {string} context.today - The current date as 'YYYY-MM-DD'.
 * @param {function} context.readState - Function to read a file from the state directory.
 * @param {function} context.writeState - Function to write a file to the state directory.
 * @returns {{success: boolean, message: string, report_path: string|null}}
 */
function execute(args, context) {
  const { today, readState, writeState } = context;

  const previousDate = new Date(today);
  previousDate.setDate(previousDate.getDate() - 1);
  const previousDateStr = previousDate.toISOString().slice(0, 10);

  const currentOntologyPath = 'state/ontology.json';
  const previousOntologyPath = `state/archive/ontology_${previousDateStr}.json`;
  const reportPath = `reports/belief_dynamics_${today}.json`;

  const currentOntologyStr = readState(currentOntologyPath);
  if (!currentOntologyStr) {
    return { success: false, message: `Could not read current ontology at ${currentOntologyPath}.`, report_path: null };
  }
  const currentOntology = JSON.parse(currentOntologyStr);

  const previousOntologyStr = readState(previousOntologyPath);
  let previousOntology = { axes: [] };
  if (previousOntologyStr) {
    previousOntology = JSON.parse(previousOntologyStr);
  } else {
    // This is not an error; it's the first run.
    console.log(`[${NAME}] Previous ontology not found at ${previousOntologyPath}. Assuming first run.`);
  }

  const prevScores = new Map(previousOntology.axes.map(axis => [axis.id, axis.score]));
  const prevUpdateTimes = new Map(previousOntology.axes.map(axis => [axis.id, axis.last_updated]));

  const axisDynamics = currentOntology.axes.map(axis => {
    const previousScore = prevScores.get(axis.id) || 0.0;
    const previousUpdateTime = prevUpdateTimes.get(axis.id) || new Date(0).toISOString();

    // Assuming evidence_log entries have { timestamp, score_impact, source_type }
    const recentEvidence = (axis.evidence_log || []).filter(
      entry => new Date(entry.timestamp) > new Date(previousUpdateTime)
    );

    const contributionSummary = {
      journal_entries: recentEvidence.filter(e => e.source_type === 'journal_entry').length,
      evidence_items: recentEvidence.filter(e => e.source_type !== 'journal_entry').length,
      positive_evidence: recentEvidence.filter(e => e.score_impact > 0).length,
      negative_evidence: recentEvidence.filter(e => e.score_impact < 0).length,
    };

    return {
      axis_id: axis.id,
      axis_label: axis.label,
      previous_score: previousScore,
      new_score: axis.score,
      delta: axis.score - previousScore,
      contribution_summary: contributionSummary,
    };
  });

  // Sort by absolute delta, descending
  axisDynamics.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const report = {
    report_date: today,
    comparison_period: {
      current: currentOntologyPath,
      previous: previousOntologyPath,
    },
    axis_dynamics: axisDynamics,
  };

  writeState(reportPath, JSON.stringify(report, null, 2));

  return { success: true, message: `Belief dynamics report generated successfully.`, report_path: reportPath };
}

/**
 * A command-line/pipeline-friendly wrapper for the tool.
 * @param {object} [options] - Options for the run.
 * @param {boolean} [options.dryRun=false] - If true, avoids writing files.
 */
function run(options = {}) {
  const { dryRun = false } = options;
  const today = new Date().toISOString().slice(0, 10);
  const projectRoot = path.join(__dirname, '..', '..');

  const mockContext = {
    today,
    readState: (filePath) => {
      const fullPath = path.join(projectRoot, filePath);
      if (!fs.existsSync(fullPath)) return null;
      return fs.readFileSync(fullPath, 'utf-8');
    },
    writeState: (filePath, content) => {
      const fullPath = path.join(projectRoot, filePath);
      if (dryRun) {
        console.log(`[${NAME}] DRY RUN: Would write ${content.length} bytes to ${fullPath}`);
        return;
      }
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content);
    },
  };

  const result = execute({}, mockContext);
  if (result.success) {
    console.log(`[${NAME}] ${result.message}`);
  } else {
    console.error(`[${NAME}] ERROR: ${result.message}`);
  }
}

module.exports = {
  name: NAME,
  description: DESCRIPTION,
  capabilities: CAPABILITIES,
  execute,
  run,
};
