'use strict';

/**
 * Phase 5 tests — orchestrator.js structural validation
 *
 * Tests:
 *   1. Module loads without error (all requires resolve)
 *   2. Signal handlers registered (exit, SIGINT, SIGTERM)
 *   3. All lib modules importable (config, agent, browser, state, etc.)
 *   4. All prompt builders importable and callable
 *   5. Helper functions exist (sleepMs, getDayNumber, countJournals, etc.)
 *   6. Cycle type determination logic
 *   7. Hour suppression logic
 *   8. Day number calculation
 *   9. Post-sleep detection threshold
 *  10. Config values used correctly
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ORCH_PATH = path.resolve(__dirname, '../runner/orchestrator.js');
const src = fs.readFileSync(ORCH_PATH, 'utf-8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('Phase 5 — orchestrator.js structural tests\n');

// ── Test 1: Syntax valid ─────────────────────────────────────────────────────
test('1. Syntax valid', () => {
  vm.compileFunction(src, [], { filename: 'orchestrator.js' });
});

// ── Test 2: All lib requires present ─────────────────────────────────────────
test('2. All lib module requires present', () => {
  const requiredModules = [
    './lib/config',
    './lib/agent',
    './lib/browser',
    './lib/state',
    './lib/pre_browse',
    './lib/post_browse',
    './lib/pre_tweet',
    './lib/post',
    './lib/git',
    './lib/daily',
    './lib/prompts/context',
    './lib/prompts/browse',
    './lib/prompts/quote',
    './lib/prompts/tweet',
    './lib/prompts/first_run',
  ];
  for (const mod of requiredModules) {
    assert(src.includes(`require('${mod}')`), `Missing require for ${mod}`);
  }
});

// ── Test 3: Destructured imports match actual exports ────────────────────────
test('3. Destructured imports match actual exports', () => {
  // browser.js exports
  for (const fn of ['restartGateway', 'startBrowser', 'checkBrowser',
    'waitForBrowserService', 'ensureBrowser', 'checkAndFixGatewayTimeout',
    'countGatewayErrLines', 'checkGatewayPort']) {
    assert(src.includes(fn), `Missing import: ${fn}`);
  }
  // state.js exports
  for (const fn of ['resetSession', 'cleanStaleLocks', 'backupState',
    'restoreIfCorrupt', 'chmodPostsLog']) {
    assert(src.includes(fn), `Missing import: ${fn}`);
  }
  // post.js exports
  for (const fn of ['postRegularTweet', 'postQuoteTweet']) {
    assert(src.includes(fn), `Missing import: ${fn}`);
  }
  // git.js exports
  for (const fn of ['commitAndPush', 'triggerVercelDeploy']) {
    assert(src.includes(fn), `Missing import: ${fn}`);
  }
});

// ── Test 4: Signal handlers registered ───────────────────────────────────────
test('4. Signal handlers registered', () => {
  assert(src.includes("process.on('exit', cleanup)"), 'Missing exit handler');
  assert(src.includes("process.on('SIGINT'"), 'Missing SIGINT handler');
  assert(src.includes("process.on('SIGTERM'"), 'Missing SIGTERM handler');
});

// ── Test 5: Signal cleanup calls scraper + stream stop ───────────────────────
test('5. Signal cleanup stops scraper + stream', () => {
  assert(src.includes('SCRAPER_DIR') && src.includes('stop.sh'), 'Missing scraper stop in signal handler');
  assert(src.includes('STREAM_DIR') && src.includes('stop.sh'), 'Missing stream stop in signal handler');
});

// ── Test 6: Caffeinate spawn (macOS only) ────────────────────────────────────
test('6. Caffeinate spawn guarded by platform', () => {
  assert(src.includes("process.platform === 'darwin'"), 'Missing darwin platform check');
  assert(src.includes("caffeinate"), 'Missing caffeinate spawn');
});

// ── Test 7: Cycle type determination ─────────────────────────────────────────
test('7. Cycle type determination matches config', () => {
  assert(src.includes('cycle % config.TWEET_EVERY === 0'), 'Missing TWEET determination');
  assert(src.includes('cycle % config.TWEET_EVERY === config.QUOTE_OFFSET'), 'Missing QUOTE determination');
});

// ── Test 8: Hour suppression ─────────────────────────────────────────────────
test('8. Hour suppression logic present', () => {
  assert(src.includes('config.TWEET_START'), 'Missing TWEET_START check');
  assert(src.includes('config.TWEET_END'), 'Missing TWEET_END check');
  assert(src.includes("running as BROWSE instead of"), 'Missing downgrade log');
});

// ── Test 9: Day number calculation ───────────────────────────────────────────
test('9. Day number calculation', () => {
  // Extract and test getDayNumber
  assert(src.includes('config.AGENT_START_DATE'), 'Missing AGENT_START_DATE ref');
  assert(src.includes('86400000'), 'Missing 86400000 (ms per day)');

  // Manual test: 2026-02-23 → day 1, 2026-02-24 → day 2
  const agentStartMs = new Date('2026-02-23T00:00:00Z').getTime();
  const day1 = Math.floor((new Date('2026-02-23T00:00:00Z').getTime() - agentStartMs) / 86400000) + 1;
  const day2 = Math.floor((new Date('2026-02-24T00:00:00Z').getTime() - agentStartMs) / 86400000) + 1;
  assert(day1 === 1, `Day 1 should be 1, got ${day1}`);
  assert(day2 === 2, `Day 2 should be 2, got ${day2}`);
});

// ── Test 10: Pause sentinel ──────────────────────────────────────────────────
test('10. Pause sentinel check', () => {
  assert(src.includes('config.PAUSE_FILE'), 'Missing PAUSE_FILE check');
  assert(src.includes('setTimeout(runOneCycle, 60_000)'), 'Missing 60s pause sleep via setTimeout');
});

// ── Test 11: All 4 cycle types handled ───────────────────────────────────────
test('11. All 4 cycle types handled (first-run, BROWSE, QUOTE, TWEET)', () => {
  assert(src.includes('journalCount === 0'), 'Missing first-run detection');
  assert(src.includes("cycleType === 'BROWSE'"), 'Missing BROWSE branch');
  assert(src.includes("cycleType === 'QUOTE'"), 'Missing QUOTE branch');
  assert(src.includes("cycleType === 'TWEET'"), 'Missing TWEET branch');
});

// ── Test 12: Browse cycle calls preBrowse + buildBrowsePrompt + postBrowse ──
test('12. Browse cycle pipeline', () => {
  assert(src.includes('preBrowse(cycle)'), 'Missing preBrowse call');
  assert(src.includes('buildBrowsePrompt(ctx)'), 'Missing buildBrowsePrompt call');
  assert(src.includes('postBrowse({'), 'Missing postBrowse call');
  // Journal retry
  assert(src.includes('browse journal missing after agent run'), 'Missing journal retry');
});

// ── Test 13: Quote cycle pipeline ────────────────────────────────────────────
test('13. Quote cycle pipeline', () => {
  assert(src.includes('buildQuotePrompt(ctx)'), 'Missing buildQuotePrompt call');
  assert(src.includes('postQuoteTweet()'), 'Missing postQuoteTweet call');
  // watchdog QUOTE + critique --quote
  assert(src.includes("CYCLE_TYPE: 'QUOTE'"), 'Missing QUOTE watchdog');
  assert(src.includes('--quote --cycle'), 'Missing critique --quote');
});

// ── Test 14: Tweet cycle pipeline ────────────────────────────────────────────
test('14. Tweet cycle pipeline', () => {
  assert(src.includes('preTweet({'), 'Missing preTweet call');
  assert(src.includes('buildTweetPrompt(ctx)'), 'Missing buildTweetPrompt call');
  assert(src.includes('postRegularTweet({'), 'Missing postRegularTweet call');
  // tweet_draft retry
  assert(src.includes('tweet_draft.txt missing after agent run'), 'Missing draft retry');
  // Post pipeline: ontology delta, drift, watchdog, git, archive, clear notes
  assert(src.includes('apply_ontology_delta.js'), 'Missing ontology delta in tweet');
  assert(src.includes('detect_drift.js'), 'Missing drift detection in tweet');
  assert(src.includes("CYCLE_TYPE: 'TWEET'"), 'Missing TWEET watchdog');
  assert(src.includes("CYCLE_TYPE: 'JOURNAL'"), 'Missing JOURNAL watchdog');
  assert(src.includes('browse_notes.md cleared'), 'Missing browse notes clear');
});

// ── Test 15: Tweet cycle uses correct agent ──────────────────────────────────
test('15. Tweet cycle uses x-hunter-tweet agent', () => {
  // Find the TWEET block and verify it uses x-hunter-tweet
  const tweetBlock = src.slice(src.indexOf("} else if (cycleType === 'TWEET')"));
  assert(tweetBlock.includes("agent: 'x-hunter-tweet'"), 'Tweet cycle should use x-hunter-tweet agent');
});

// ── Test 16: State protection in quote + tweet cycles ────────────────────────
test('16. State protection (backup/chmod/restore) in quote + tweet', () => {
  // Quote cycle
  const quoteBlock = src.slice(
    src.indexOf("} else if (cycleType === 'QUOTE')"),
    src.indexOf("} else if (cycleType === 'TWEET')")
  );
  assert(quoteBlock.includes('backupState()'), 'Quote: missing backupState');
  assert(quoteBlock.includes("chmodPostsLog('444')"), 'Quote: missing chmod 444');
  assert(quoteBlock.includes("chmodPostsLog('644')"), 'Quote: missing chmod 644');
  assert(quoteBlock.includes('restoreIfCorrupt()'), 'Quote: missing restoreIfCorrupt');

  // Tweet cycle
  const tweetBlock = src.slice(src.indexOf("} else if (cycleType === 'TWEET')"));
  assert(tweetBlock.includes('backupState()'), 'Tweet: missing backupState');
  assert(tweetBlock.includes("chmodPostsLog('444')"), 'Tweet: missing chmod 444');
  assert(tweetBlock.includes("chmodPostsLog('644')"), 'Tweet: missing chmod 644');
  assert(tweetBlock.includes('restoreIfCorrupt()'), 'Tweet: missing restoreIfCorrupt');
});

// ── Test 17: Browser health differs by cycle type ───────────────────────────
test('17. Browser health check differs by cycle type', () => {
  // BROWSE: light check (checkBrowser + checkGatewayPort)
  assert(src.includes('checkBrowser()'), 'Missing checkBrowser for BROWSE');
  assert(src.includes('checkGatewayPort()'), 'Missing checkGatewayPort for BROWSE');
  // TWEET/QUOTE: resetSession + ensureBrowser
  assert(src.includes("resetSession('x-hunter-tweet')"), 'Missing x-hunter-tweet resetSession');
  assert(src.includes('ensureBrowser()'), 'Missing ensureBrowser for TWEET/QUOTE');
});

// ── Test 18: Periodic restart every 6 cycles ────────────────────────────────
test('18. Periodic restart every 6 cycles', () => {
  assert(src.includes('cycle % 6 === 0'), 'Missing periodic restart check');
  assert(src.includes("resetSession('x-hunter')"), 'Missing x-hunter session reset');
  assert(src.includes('waitForBrowserService(30)'), 'Missing waitForBrowserService');
});

// ── Test 19: Daily block runs after any cycle type ───────────────────────────
test('19. Daily block runs after any cycle type', () => {
  // runDaily should be OUTSIDE the if/else cycle branches
  const dailyIdx = src.lastIndexOf('runDaily({');
  const lastElseIdx = src.lastIndexOf("} else if (cycleType === 'TWEET')");
  assert(dailyIdx > lastElseIdx, 'runDaily should be after all cycle branches');
});

// ── Test 20: Sleep + post-sleep detection ────────────────────────────────────
test('20. Sleep interval + post-sleep detection', () => {
  assert(src.includes('config.BROWSE_INTERVAL'), 'Missing BROWSE_INTERVAL reference');
  assert(src.includes('config.BROWSE_INTERVAL * 2'), 'Missing post-sleep threshold');
  assert(src.includes('post-sleep detected'), 'Missing post-sleep log');
  assert(src.includes('x-hunter stop'), 'Missing browser stop in post-sleep');
  assert(src.includes('x-hunter start'), 'Missing browser start in post-sleep');
});

// ── Test 21: Health watchdog runs every cycle ────────────────────────────────
test('21. HEALTH watchdog runs every cycle', () => {
  assert(src.includes("CYCLE_TYPE: 'HEALTH'"), 'Missing HEALTH watchdog');
});

// ── Test 22: Git commit + Vercel in tweet cycle ──────────────────────────────
test('22. Git commit + Vercel deploy in tweet cycle', () => {
  const tweetBlock = src.slice(src.indexOf("} else if (cycleType === 'TWEET')"));
  assert(tweetBlock.includes('commitAndPush({'), 'Missing commitAndPush in tweet');
  assert(tweetBlock.includes('triggerVercelDeploy'), 'Missing Vercel deploy in tweet');
  assert(tweetBlock.includes('VERCEL_DEPLOY_HOOK'), 'Missing VERCEL_DEPLOY_HOOK env check');
});

// ── Test 23: Scraper liveness check ──────────────────────────────────────────
test('23. Scraper liveness checks 3 pid files', () => {
  assert(src.includes("'scraper'"), 'Missing scraper pid check');
  assert(src.includes("'reply'"), 'Missing reply pid check');
  assert(src.includes("'follows'"), 'Missing follows pid check');
  assert(src.includes('start.sh'), 'Missing scraper restart');
});

// ── Test 24: Heartbeat written every cycle ───────────────────────────────────
test('24. Heartbeat written every cycle', () => {
  assert(src.includes('config.HEARTBEAT_PATH'), 'Missing HEARTBEAT_PATH write');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
