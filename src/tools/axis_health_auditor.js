'use strict';

const fs = require('fs');
const path = require('path');

const TOOL_NAME = 'axis_health_auditor';
const TOOL_DESCRIPTION = 'Analyzes belief history for volatility, stagnation, and drift.';
const CAPABILITIES = {
  read: ['state/belief_history.jsonl', 'state/ontology.json'],
  write: ['state/reports/axis_health_audit.json'],
  call_tools: [],
};

// --- Configuration ---
const HIGH_CONFIDENCE_THRESHOLD = 0.4;
const STAGNATION_THRESHOLD = 0.01; // Max daily change to be considered stagnant
const LOOKBACK_DAYS = [7, 14]; // Analyze over 7 and 14 day windows

/**
 * Calculates the standard deviation of an array of numbers.
 * @param {number[]} arr - Array of numbers.
 * @returns {number} The standard deviation.
 */
function standardDeviation(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((acc, val) => acc + val, 0) / arr.length;
  // Using n-1 for sample standard deviation
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Parses the belief history from a JSONL string.
 * @param {string} historyContent - The content of belief_history.jsonl.
 * @returns {Map<string, {date: string, score: number}[]>} A map of axisId to its score history.
 */
function parseHistory(historyContent) {
  const historyByAxis = new Map();
  if (!historyContent) return historyByAxis;
  const lines = historyContent.trim().split('\n');

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (!record.axis_id || typeof record.score !== 'number' || !record.date) continue;

      if (!historyByAxis.has(record.axis_id)) {
        historyByAxis.set(record.axis_id, []);
      }
      historyByAxis.get(record.axis_id).push({ date: record.date, score: record.score });
    } catch (e) {
      // Ignore malformed lines
    }
  }

  // Sort each axis's history by date ascending
  for (const records of historyByAxis.values()) {
    records.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  return historyByAxis;
}

/**
 * The core logic of the tool, suitable for sandboxed execution.
 * @param {object} args - Tool arguments (currently unused).
 * @param {object} context - The sandboxed execution context.
 * @returns {{success: boolean, message: string, report?: object}} Result object.
 */
function execute(args, context) {
  let ontologyContent;
  let historyContent;

  try {
    ontologyContent = context.readState('state/ontology.json');
    historyContent = context.readState('state/belief_history.jsonl');
  } catch (e) {
    if (e.code === 'ENOENT' && e.path.includes('belief_history.jsonl')) {
        historyContent = ''; // If history doesn't exist, treat as empty
    } else {
        return { success: false, message: `Failed to read state files: ${e.message}` };
    }
  }

  const ontology = JSON.parse(ontologyContent);
  const highConfidenceAxes = ontology.axes.filter(
    (axis) => axis.confidence >= HIGH_CONFIDENCE_THRESHOLD
  );

  const report = {
    createdAt: new Date().toISOString(),
    auditedAxes: 0,
    flags: [],
    metrics: {}
  };

  if (highConfidenceAxes.length === 0) {
    const message = 'No high-confidence axes to audit.';
    context.writeState('state/reports/axis_health_audit.json', JSON.stringify(report, null, 2));
    return { success: true, message, report };
  }

  const historyByAxis = parseHistory(historyContent);
  report.auditedAxes = highConfidenceAxes.length;

  for (const axis of highConfidenceAxes) {
    const axisHistory = historyByAxis.get(axis.id) || [];
    if (axisHistory.length < 2) continue;

    const axisMetrics = {
      id: axis.id,
      label: axis.label,
      currentScore: axis.score,
      currentConfidence: axis.confidence,
      historyLength: axisHistory.length,
    };

    for (const days of LOOKBACK_DAYS) {
      const recentHistory = axisHistory.slice(-days);
      if (recentHistory.length < 2) continue;

      const scores = recentHistory.map(h => h.score);
      const volatility = standardDeviation(scores);
      const drift = scores[scores.length - 1] - scores[0];

      let stagnantPeriods = 0;
      for (let i = 1; i < recentHistory.length; i++) {
        if (Math.abs(recentHistory[i].score - recentHistory[i-1].score) < STAGNATION_THRESHOLD) {
          stagnantPeriods++;
        }
      }
      // Stagnation is a ratio of periods with minimal change
      axisMetrics[`stagnation_score_${days}d`] = stagnantPeriods / (recentHistory.length - 1);
      axisMetrics[`volatility_${days}d`] = volatility;
      axisMetrics[`drift_${days}d`] = drift;
    }
    report.metrics[axis.id] = axisMetrics;
  }

  // Flagging logic
  for (const axisId in report.metrics) {
      const m = report.metrics[axisId];
      if (m[`stagnation_score_7d`] >= 0.8 && m.historyLength >= 7) {
          report.flags.push({
              axisId,
              type: 'Stagnation',
              message: `Axis has shown minimal change for ~${Math.round(m[`stagnation_score_7d`] * 6)} of the last 7 days.`
          });
      }
      if (m[`volatility_7d`] > 0.1) {
          report.flags.push({
              axisId,
              type: 'Volatility',
              message: `Axis score is highly volatile (stddev > 0.1) over the last 7 days.`
          });
      }
  }

  try {
    context.writeState('state/reports/axis_health_audit.json', JSON.stringify(report, null, 2));
  } catch (e) {
    return { success: false, message: `Failed to write report: ${e.message}` };
  }

  return { success: true, message: `Axis health audit complete. Audited ${highConfidenceAxes.length} axes.`, report };
}

/**
 * Standalone runner for use in pipelines.
 * @param {{dryRun?: boolean}} options - Runner options.
 */
function run(options = {}) {
  const { dryRun = false } = options;
  const projectRoot = path.join(__dirname, '..', '..');

  console.log(`[${TOOL_NAME}] Running axis health audit...`);

  const context = {
    readState: (filePath) => {
      return fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
    },
    writeState: (filePath, content) => {
      if (dryRun) {
        console.log(`[${TOOL_NAME}] DRY RUN: Would write to ${filePath}`);
        // console.log('--- CONTENT ---\n' + content + '\n--- END CONTENT ---');
      } else {
        const fullPath = path.join(projectRoot, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        console.log(`[${TOOL_NAME}] Wrote report to ${filePath}`);
      }
    },
  };

  const result = execute({}, context);

  if (result.success) {
    console.log(`[${TOOL_NAME}] ${result.message}`);
  } else {
    console.error(`[${TOOL_NAME}] Error: ${result.message}`);
    throw new Error(result.message);
  }
}

module.exports = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  capabilities: CAPABILITIES,
  execute,
  run,
};
