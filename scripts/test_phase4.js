#!/usr/bin/env node
'use strict';

/**
 * scripts/test_phase4.js — Phase 4 unit tests for daily.js
 *
 * Tests module loading, self-gate logic, file maintenance helpers,
 * and sub-section structure. Does NOT call real runner scripts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── Module loading ───────────────────────────────────────────────────────────

console.log('\n=== Module Loading ===');

test('daily.js loads and exports expected functions', () => {
  const daily = require('../runner/lib/daily');
  assert(typeof daily.runDaily === 'function', 'runDaily not a function');
  assert(typeof daily.shouldRun === 'function', 'shouldRun not a function');
  assert(typeof daily.reports === 'function', 'reports not a function');
  assert(typeof daily.checkpoint === 'function', 'checkpoint not a function');
  assert(typeof daily.ponder === 'function', 'ponder not a function');
  assert(typeof daily.sprint === 'function', 'sprint not a function');
  assert(typeof daily.housekeeping === 'function', 'housekeeping not a function');
  assert(typeof daily.trimFile === 'function', 'trimFile not a function');
  assert(typeof daily.rotateLog === 'function', 'rotateLog not a function');
});

// ── Self-gate tests ──────────────────────────────────────────────────────────

console.log('\n=== Self-gate (shouldRun) ===');

test('shouldRun returns false when last_daily_at.txt is recent', () => {
  const daily = require('../runner/lib/daily');
  const lastDailyPath = path.join(STATE_DIR, 'last_daily_at.txt');
  const origContent = fs.existsSync(lastDailyPath) ? fs.readFileSync(lastDailyPath, 'utf-8') : null;

  // Write current epoch — should NOT fire (< 24h)
  const nowEpoch = Math.floor(Date.now() / 1000);
  fs.writeFileSync(lastDailyPath, String(nowEpoch));
  assert(daily.shouldRun() === false, 'should not fire when < 24h elapsed');

  // Restore
  if (origContent !== null) {
    fs.writeFileSync(lastDailyPath, origContent);
  } else {
    try { fs.unlinkSync(lastDailyPath); } catch {}
  }
});

test('shouldRun returns true when last_daily_at.txt is old or missing', () => {
  const daily = require('../runner/lib/daily');
  const lastDailyPath = path.join(STATE_DIR, 'last_daily_at.txt');
  const origContent = fs.existsSync(lastDailyPath) ? fs.readFileSync(lastDailyPath, 'utf-8') : null;

  // Write epoch from 25h ago — should fire
  const oldEpoch = Math.floor(Date.now() / 1000) - 90000;
  fs.writeFileSync(lastDailyPath, String(oldEpoch));
  assert(daily.shouldRun() === true, 'should fire when > 24h elapsed');

  // Restore
  if (origContent !== null) {
    fs.writeFileSync(lastDailyPath, origContent);
  } else {
    try { fs.unlinkSync(lastDailyPath); } catch {}
  }
});

test('shouldRun returns true when file is missing', () => {
  const daily = require('../runner/lib/daily');
  const lastDailyPath = path.join(STATE_DIR, 'last_daily_at.txt');
  const origContent = fs.existsSync(lastDailyPath) ? fs.readFileSync(lastDailyPath, 'utf-8') : null;

  try { fs.unlinkSync(lastDailyPath); } catch {}
  assert(daily.shouldRun() === true, 'should fire when file missing');

  // Restore
  if (origContent !== null) {
    fs.writeFileSync(lastDailyPath, origContent);
  }
});

// ── File maintenance helpers ─────────────────────────────────────────────────

console.log('\n=== trimFile ===');

test('trimFile trims oversized file', () => {
  const daily = require('../runner/lib/daily');
  const tmpFile = path.join(os.tmpdir(), 'hunter_test_trim.txt');

  // Create a 20-line file, trim to 10
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(tmpFile, lines);
  daily.trimFile(tmpFile, 10);
  const result = fs.readFileSync(tmpFile, 'utf-8').trim().split('\n');
  assert(result.length === 10, `expected 10 lines, got ${result.length}`);
  assert(result[0] === 'line 11', `expected "line 11", got "${result[0]}"`);
  assert(result[9] === 'line 20', `expected "line 20", got "${result[9]}"`);

  try { fs.unlinkSync(tmpFile); } catch {}
});

test('trimFile is a no-op when file is under limit', () => {
  const daily = require('../runner/lib/daily');
  const tmpFile = path.join(os.tmpdir(), 'hunter_test_trim2.txt');

  const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(tmpFile, lines);
  daily.trimFile(tmpFile, 10);
  const result = fs.readFileSync(tmpFile, 'utf-8').trim().split('\n');
  assert(result.length === 5, `expected 5 lines, got ${result.length}`);

  try { fs.unlinkSync(tmpFile); } catch {}
});

console.log('\n=== rotateLog ===');

test('rotateLog preserves inode (in-place overwrite)', () => {
  const daily = require('../runner/lib/daily');
  const tmpFile = path.join(os.tmpdir(), 'hunter_test_rotate.log');

  // Create a 20-line file
  const lines = Array.from({ length: 20 }, (_, i) => `log ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(tmpFile, lines);

  // Get inode before
  const inodeBefore = fs.statSync(tmpFile).ino;

  daily.rotateLog(tmpFile, 10);

  // Get inode after — must be the same (inode preserved)
  const inodeAfter = fs.statSync(tmpFile).ino;
  assert(inodeBefore === inodeAfter, `inode changed: ${inodeBefore} → ${inodeAfter}`);

  const result = fs.readFileSync(tmpFile, 'utf-8').trim().split('\n');
  assert(result.length === 10, `expected 10 lines, got ${result.length}`);
  assert(result[0] === 'log 11', `expected "log 11", got "${result[0]}"`);

  try { fs.unlinkSync(tmpFile); } catch {}
});

// ── runDaily gate test ───────────────────────────────────────────────────────

console.log('\n=== runDaily gate ===');

test('runDaily returns false when < 24h elapsed (skips all work)', () => {
  const daily = require('../runner/lib/daily');
  const lastDailyPath = path.join(STATE_DIR, 'last_daily_at.txt');
  const origContent = fs.existsSync(lastDailyPath) ? fs.readFileSync(lastDailyPath, 'utf-8') : null;

  // Set recent timestamp
  const nowEpoch = Math.floor(Date.now() / 1000);
  fs.writeFileSync(lastDailyPath, String(nowEpoch));

  const result = daily.runDaily({ today: '2026-03-22' });
  assert(result === false, `expected false (skipped), got ${result}`);

  // Restore
  if (origContent !== null) {
    fs.writeFileSync(lastDailyPath, origContent);
  } else {
    try { fs.unlinkSync(lastDailyPath); } catch {}
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
