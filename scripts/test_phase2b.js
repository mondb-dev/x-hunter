#!/usr/bin/env node
'use strict';

/**
 * scripts/test_phase2b.js — test pre_browse, post_browse, pre_tweet modules
 */

const fs = require('fs');
const config = require('../runner/lib/config');
const { preTweet } = require('../runner/lib/pre_tweet');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

// Save originals
const origNotes = fs.existsSync(config.BROWSE_NOTES_PATH)
  ? fs.readFileSync(config.BROWSE_NOTES_PATH, 'utf-8') : '';
const origDraft = fs.existsSync(config.TWEET_DRAFT_PATH)
  ? fs.readFileSync(config.TWEET_DRAFT_PATH, 'utf-8') : '';

console.log('=== preTweet tests ===');

// Test 1: short notes (<80 chars) → should return false
fs.writeFileSync(config.BROWSE_NOTES_PATH, 'short');
assert('short notes returns false', preTweet({ cycle: 1, today: '2026-03-22', now: '13:00' }) === false);
assert('SKIP written on short notes', fs.readFileSync(config.TWEET_DRAFT_PATH, 'utf-8').trim() === 'SKIP');

// Test 2: failure phrase → should return false
fs.writeFileSync(config.BROWSE_NOTES_PATH, 'A'.repeat(100) + ' browser control service unavailable');
assert('failure phrase returns false', preTweet({ cycle: 2, today: '2026-03-22', now: '13:00' }) === false);

// Test 3: "no new observations" phrase
fs.writeFileSync(config.BROWSE_NOTES_PATH, 'A'.repeat(100) + ' no new observations today');
assert('no new observations returns false', preTweet({ cycle: 3, today: '2026-03-22', now: '13:00' }) === false);

// Test 4: normal notes → should return true
fs.writeFileSync(config.BROWSE_NOTES_PATH, 'A'.repeat(100) + ' interesting discourse about epistemic norms');
assert('normal notes returns true', preTweet({ cycle: 4, today: '2026-03-22', now: '13:00' }) === true);

// Test 5: verify archive was written (from test 4)
if (fs.existsSync(config.BROWSE_ARCHIVE_PATH)) {
  const archive = fs.readFileSync(config.BROWSE_ARCHIVE_PATH, 'utf-8');
  assert('archive contains cycle header', archive.includes('cycle 4'));
}

// Restore originals
fs.writeFileSync(config.BROWSE_NOTES_PATH, origNotes);
fs.writeFileSync(config.TWEET_DRAFT_PATH, origDraft);

console.log('\n=== Module loading tests ===');
const preBrowse = require('../runner/lib/pre_browse');
const postBrowse = require('../runner/lib/post_browse');
assert('pre_browse.preBrowse is function', typeof preBrowse.preBrowse === 'function');
assert('post_browse.postBrowse is function', typeof postBrowse.postBrowse === 'function');
assert('pre_tweet.preTweet is function', typeof preTweet === 'function');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
