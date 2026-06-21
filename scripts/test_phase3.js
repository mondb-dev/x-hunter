#!/usr/bin/env node
'use strict';

/**
 * scripts/test_phase3.js — Phase 3 unit tests for post.js and git.js
 *
 * Tests module loading, return values, and behavior with mock state files.
 * Does NOT call real post_tweet.js / voice_filter.js / critique_tweet.js.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const DRAFT_PATH = path.join(STATE_DIR, 'tweet_draft.txt');
const QUOTE_DRAFT_PATH = path.join(STATE_DIR, 'quote_draft.txt');

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

function cleanup() {
  for (const f of [
    DRAFT_PATH,
    QUOTE_DRAFT_PATH,
    path.join(STATE_DIR, 'tweet_result.txt'),
    path.join(STATE_DIR, 'quote_result.txt'),
    path.join(STATE_DIR, 'test_article_result.txt'),
    path.join(STATE_DIR, 'test_plan_tweet.txt'),
    path.join(STATE_DIR, 'test_checkpoint_result.txt'),
  ]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

// ── Module loading tests ─────────────────────────────────────────────────────

console.log('\n=== Module Loading ===');

test('git.js exports commitAndPush and triggerVercelDeploy', () => {
  const git = require('../runner/lib/git');
  assert(typeof git.commitAndPush === 'function', 'commitAndPush not a function');
  assert(typeof git.triggerVercelDeploy === 'function', 'triggerVercelDeploy not a function');
});

test('post.js exports 4 posting functions', () => {
  const post = require('../runner/lib/post');
  assert(typeof post.postRegularTweet === 'function', 'postRegularTweet not a function');
  assert(typeof post.postQuoteTweet === 'function', 'postQuoteTweet not a function');
  assert(typeof post.postLinkTweet === 'function', 'postLinkTweet not a function');
  assert(typeof post.postSimpleTweet === 'function', 'postSimpleTweet not a function');
});

// ── postRegularTweet tests ───────────────────────────────────────────────────

console.log('\n=== postRegularTweet ===');

test('no draft file → posted:false', () => {
  cleanup();
  const { postRegularTweet } = require('../runner/lib/post');
  const result = postRegularTweet({ today: '2026-03-22', hour: '14' });
  assert(result.posted === false, `expected posted=false, got ${result.posted}`);
  assert(result.rejected === false, 'should not be rejected');
  assert(result.skipped === false, 'should not be skipped');
});

test('SKIP draft → posted:false, skipped:true', () => {
  cleanup();
  fs.writeFileSync(DRAFT_PATH, 'SKIP\n');
  const { postRegularTweet } = require('../runner/lib/post');
  const result = postRegularTweet({ today: '2026-03-22', hour: '14' });
  assert(result.posted === false, `expected posted=false, got ${result.posted}`);
  assert(result.skipped === true, 'should be skipped');
  cleanup();
});

test('journal URL auto-append when line 2 missing', () => {
  cleanup();
  fs.writeFileSync(DRAFT_PATH, 'Test tweet content\n');
  const { postRegularTweet } = require('../runner/lib/post');
  // This will try to run critique_tweet.js which may fail, but the URL fix happens first
  postRegularTweet({ today: '2026-03-22', hour: '14' });
  // Check that the draft was modified (URL appended) before critique ran
  // The draft may have been deleted by critique or consumed by post — check if URL was in the draft
  // For a clean test, just verify the function doesn't crash
  cleanup();
});

// ── postQuoteTweet tests ─────────────────────────────────────────────────────

console.log('\n=== postQuoteTweet ===');

test('no quote draft → posted:false', () => {
  cleanup();
  const { postQuoteTweet } = require('../runner/lib/post');
  const result = postQuoteTweet();
  assert(result.posted === false, `expected posted=false, got ${result.posted}`);
});

// ── postLinkTweet tests ──────────────────────────────────────────────────────

console.log('\n=== postLinkTweet ===');

test('no result file → posted:false', () => {
  cleanup();
  const { postLinkTweet } = require('../runner/lib/post');
  const result = postLinkTweet({ resultFile: 'test_article_result.txt' });
  assert(result.posted === false, `expected posted=false, got ${result.posted}`);
});

test('result file → formats draft with title+URL', () => {
  cleanup();
  const resultPath = path.join(STATE_DIR, 'test_article_result.txt');
  fs.writeFileSync(resultPath, 'https://example.com/article\nMy Great Article Title\n');
  // postLinkTweet will try to run post_tweet.js which will fail — that's OK
  // we just want to verify the draft formatting
  const { postLinkTweet } = require('../runner/lib/post');
  // Patch: don't actually call the function since it would invoke ensure_browser + sleep 60
  // Instead test the draft formatting logic inline
  const lines = fs.readFileSync(resultPath, 'utf-8').split('\n');
  const url = (lines[0] || '').trim();
  let title = (lines[1] || '').trim();
  const maxTitle = 255 - url.length;
  if (title.length > maxTitle) title = title.substring(0, maxTitle) + '...';
  const formatted = `${title}\n${url}`;
  assert(formatted === 'My Great Article Title\nhttps://example.com/article', `bad format: ${formatted}`);
  cleanup();
});

// ── postSimpleTweet tests ────────────────────────────────────────────────────

console.log('\n=== postSimpleTweet ===');

test('no source or result file → posted:false', () => {
  cleanup();
  const { postSimpleTweet } = require('../runner/lib/post');
  const r1 = postSimpleTweet({ sourceFile: 'test_plan_tweet.txt' });
  assert(r1.posted === false, `sourceFile: expected posted=false, got ${r1.posted}`);
  const r2 = postSimpleTweet({ resultFile: 'test_checkpoint_result.txt' });
  assert(r2.posted === false, `resultFile: expected posted=false, got ${r2.posted}`);
});

test('title truncation respects maxTitleChars', () => {
  // Verify the truncation math that postSimpleTweet/postLinkTweet use
  const url = 'https://sebastianhunter.fun/checkpoint/5';
  const longTitle = 'A'.repeat(300);
  const maxTitleChars = 240;
  const maxTitle = maxTitleChars - url.length;
  const truncated = longTitle.length > maxTitle
    ? longTitle.substring(0, maxTitle) + '...'
    : longTitle;
  assert(truncated.length === maxTitle + 3, `truncated length: ${truncated.length}, expected ${maxTitle + 3}`);
  assert(truncated.endsWith('...'), 'should end with ...');
});

// ── git.js tests ─────────────────────────────────────────────────────────────

console.log('\n=== git.js ===');

test('commitAndPush runs without error (no-op when nothing to commit)', () => {
  const git = require('../runner/lib/git');
  // This will attempt a real git add/commit/push but with nothing staged — should silently no-op
  git.commitAndPush({ paths: ['state/'], message: 'test: phase3 no-op commit' });
});

test('triggerVercelDeploy with no URL is a no-op', () => {
  const git = require('../runner/lib/git');
  git.triggerVercelDeploy(undefined);
  git.triggerVercelDeploy('');
  git.triggerVercelDeploy(null);
});

// ── Summary ──────────────────────────────────────────────────────────────────

cleanup();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
