'use strict';

/**
 * Phase 6 structural tests — default switch + structured logging
 *
 * Tests:
 * 1.  run.sh default is now "node"
 * 2.  run.sh path A (bash) still intact
 * 3.  config.js exports ORCHESTRATOR_LOG_PATH
 * 4.  orchestrator.js has structuredLog function
 * 5.  structuredLog writes JSON lines to ORCHESTRATOR_LOG_PATH
 * 6.  newCycleMetrics returns expected shape
 * 7.  All agentRun calls capture exit codes into metrics
 * 8.  TWEET cycle captures postRegularTweet result
 * 9.  QUOTE cycle captures postQuoteTweet result
 * 10. Structured log entry emitted at end of each cycle
 * 11. Health metrics include totalCycles, postSuccessRate, etc.
 * 12. Downgrade tracking (metrics.downgradedToBrowse)
 * 13. Browser restart tracking (metrics.browserRestarted)
 * 14. orchestrator.log in .gitignore
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function test(n, label, fn) {
  try {
    fn();
    console.log(`  ✅ ${n}. ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${n}. ${label}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const runSh = fs.readFileSync(path.join(ROOT, 'runner/run.sh'), 'utf-8');
const orch = fs.readFileSync(path.join(ROOT, 'runner/orchestrator.js'), 'utf-8');
const configSrc = fs.readFileSync(path.join(ROOT, 'runner/lib/config.js'), 'utf-8');
const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');

console.log('\nPhase 6 — default switch + structured logging tests\n');

// 1. run.sh default is now "node"
test(1, 'run.sh default is ORCHESTRATOR=node', () => {
  assert(runSh.includes('ORCHESTRATOR="${ORCHESTRATOR:-node}"'),
    'Expected ORCHESTRATOR default to be "node"');
  assert(!runSh.includes('ORCHESTRATOR="${ORCHESTRATOR:-bash}"'),
    'Old bash default should not be present');
});

// 2. run.sh path A (bash) still intact
test(2, 'run.sh path A (bash while loop) still intact', () => {
  // The main while loop in bash path A should still exist
  assert(runSh.includes('while true; do') || runSh.includes('while true\ndo'),
    'bash while loop should still exist');
  assert(runSh.includes('# ── Session reset helper'),
    'bash session reset section should still exist');
});

// 3. config.js exports ORCHESTRATOR_LOG_PATH
test(3, 'config.js exports ORCHESTRATOR_LOG_PATH', () => {
  assert(configSrc.includes('ORCHESTRATOR_LOG_PATH'),
    'config.js should define ORCHESTRATOR_LOG_PATH');
  assert(configSrc.includes("orchestrator.log"),
    'ORCHESTRATOR_LOG_PATH should point to orchestrator.log');
});

// 4. orchestrator.js has structuredLog function
test(4, 'orchestrator.js defines structuredLog()', () => {
  assert(orch.includes('function structuredLog(entry)'),
    'structuredLog function should be defined');
});

// 5. structuredLog writes JSON to ORCHESTRATOR_LOG_PATH
test(5, 'structuredLog writes JSON lines to ORCHESTRATOR_LOG_PATH', () => {
  assert(orch.includes('JSON.stringify(entry)'),
    'should use JSON.stringify');
  assert(orch.includes('config.ORCHESTRATOR_LOG_PATH'),
    'should reference config.ORCHESTRATOR_LOG_PATH');
  assert(orch.includes('appendFileSync'),
    'should use appendFileSync for append-only writes');
});

// 6. newCycleMetrics returns expected shape
test(6, 'newCycleMetrics() returns expected shape', () => {
  assert(orch.includes('function newCycleMetrics()'),
    'newCycleMetrics function should be defined');
  assert(orch.includes('agentExitCodes: []'),
    'should track agentExitCodes');
  assert(orch.includes('postAttempted: false'),
    'should track postAttempted');
  assert(orch.includes('postSuccess: null'),
    'should track postSuccess');
  assert(orch.includes('browserRestarted: false'),
    'should track browserRestarted');
  assert(orch.includes('downgradedToBrowse: false'),
    'should track downgradedToBrowse');
});

// 7. All agentRun calls capture exit codes
test(7, 'All agentRun calls push exit codes to metrics', () => {
  // Count agentRun call sites (excluding import and comment lines)
  const agentRunCalls = orch.split('\n').filter(line =>
    line.includes('agentRun(') &&
    !line.includes('require') &&
    !line.includes('//') &&
    !line.trim().startsWith('*')
  );
  const exitCaptures = orch.split('\n').filter(line =>
    line.includes('metrics.agentExitCodes.push(')
  );
  assert(agentRunCalls.length >= 5,
    `Expected ≥5 agentRun calls, found ${agentRunCalls.length}`);
  assert(exitCaptures.length >= 5,
    `Expected ≥5 exit code captures, found ${exitCaptures.length}`);
});

// 8. TWEET cycle captures postRegularTweet result
test(8, 'TWEET cycle captures postRegularTweet result', () => {
  assert(orch.includes('const tweetResult = postRegularTweet('),
    'should capture postRegularTweet return value');
  assert(orch.includes('metrics.postSuccess = tweetResult.posted'),
    'should record tweetResult.posted');
});

// 9. QUOTE cycle captures postQuoteTweet result
test(9, 'QUOTE cycle captures postQuoteTweet result', () => {
  assert(orch.includes('const quoteResult = postQuoteTweet()'),
    'should capture postQuoteTweet return value');
  assert(orch.includes('metrics.postSuccess = quoteResult.posted'),
    'should record quoteResult.posted');
});

// 10. Structured log entry emitted at end of each cycle
test(10, 'structuredLog called at end of each cycle', () => {
  assert(orch.includes('structuredLog({'),
    'structuredLog should be called with an object');
  // Verify it's after the daily block and before sleep
  const structLogPos = orch.indexOf('structuredLog({');
  const dailyPos = orch.indexOf('runDaily(');
  const sleepPos = orch.indexOf("sleepSec(wait)");
  assert(structLogPos > dailyPos,
    'structured log should come after daily maintenance');
  assert(structLogPos < sleepPos,
    'structured log should come before sleep');
});

// 11. Health metrics include running totals
test(11, 'Health metrics include totalCycles and postSuccessRate', () => {
  assert(orch.includes('totalCycles'),
    'should track totalCycles');
  assert(orch.includes('postSuccessRate'),
    'should compute postSuccessRate');
  assert(orch.includes('totalPostAttempts'),
    'should track totalPostAttempts');
  assert(orch.includes('totalPostSuccesses'),
    'should track totalPostSuccesses');
});

// 12. Downgrade tracking
test(12, 'Downgrade events set metrics.downgradedToBrowse', () => {
  const downgradeSets = orch.split('\n').filter(line =>
    line.includes('metrics.downgradedToBrowse = true')
  );
  assert(downgradeSets.length >= 2,
    `Expected ≥2 downgrade tracking points, found ${downgradeSets.length}`);
});

// 13. Browser restart tracking
test(13, 'Browser restart sets metrics.browserRestarted', () => {
  assert(orch.includes('metrics.browserRestarted = true'),
    'should set metrics.browserRestarted on restart');
});

// 14. orchestrator.log in .gitignore
test(14, 'orchestrator.log is in .gitignore', () => {
  assert(gitignore.includes('runner/orchestrator.log'),
    'runner/orchestrator.log should be in .gitignore');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
