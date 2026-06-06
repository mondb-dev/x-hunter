#!/usr/bin/env node
'use strict';
/**
 * runner/post_thread.js — post a 4-tweet discourse thread via CDP
 *
 * Reads state/thread_draft.json → voice-checks all tweets →
 * posts tweet1, then self-replies with tweet2, tweet3, tweet4.
 * Updates state/thread_state.json on success.
 * Exit 0 = all posted, exit 1 = failure.
 */

const fs   = require('fs');
const path = require('path');
const { connectBrowser, getXPage } = require('./cdp');
const { logTweet } = require('./posts_log');
const { HANDLE, isConfirmedStatusUrl } = require('./post_result');
const { check: voiceCheck } = require('./lib/voice_filter');

const config = require('./lib/config');

const DRAFT_PATH = path.join(config.STATE_DIR, 'thread_draft.json');
const STATE_PATH = path.join(config.STATE_DIR, 'thread_state.json');

const COMPOSE_BOX = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
const REPLY_BTN   = '[data-testid="reply"]';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function humanDelay(min, max) { return sleep(min + Math.floor(Math.random() * (max - min))); }

async function typeIntoCompose(page, text, selector) {
  await page.click(selector);
  await sleep(300);
  await page.evaluate((txt, sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    // Clear leftover draft before insert so text is not spliced into stale content.
    document.execCommand('selectAll');
    document.execCommand('delete');
    document.execCommand('insertText', false, txt);
  }, text, selector);
  await sleep(1200);
  const inserted = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.trim() : '';
  }, selector);
  if (inserted !== text.trim()) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
    }, selector);
    await sleep(300);
    await page.click(selector);
    await page.keyboard.type(text, { delay: 20 });
    await sleep(800);
  }
}

async function postTweet(page, text) {
  await page.goto('https://x.com/compose/post', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await sleep(2000);
  await page.waitForSelector(COMPOSE_BOX, { timeout: 15000 });
  await typeIntoCompose(page, text, COMPOSE_BOX);
  await humanDelay(800, 1500);
  await page.click(POST_BUTTON);
  await sleep(4000);
  return confirmFromProfile(page, text);
}

async function postReply(page, tweetUrl, text) {
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  const clicked = await page.evaluate((sel) => {
    const articles = document.querySelectorAll('article');
    if (articles.length === 0) return false;
    const btn = articles[0].querySelector(sel);
    if (btn) { btn.click(); return true; }
    return false;
  }, REPLY_BTN);
  if (!clicked) {
    try { await page.click(REPLY_BTN); }
    catch { throw new Error('Reply button not found on tweet'); }
  }
  await sleep(2000);
  await page.waitForSelector(COMPOSE_BOX, { timeout: 10000 });
  await typeIntoCompose(page, text, COMPOSE_BOX);
  await humanDelay(800, 1500);
  await page.click(POST_BUTTON);
  await sleep(4000);
  return confirmFromProfile(page, text);
}

async function confirmFromProfile(page, expectedText, attempts = 4, delayMs = 3000) {
  const needle = expectedText.slice(0, 80).toLowerCase().replace(/\s+/g, ' ').trim();
  await page.goto('https://x.com/' + HANDLE, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delayMs);
    const match = await page.evaluate(({ expectedNeedle, handle }) => {
      const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const articles = Array.from(document.querySelectorAll('article')).slice(0, 12);
      for (const article of articles) {
        const text = norm(article.innerText);
        if (!text || !text.includes(expectedNeedle)) continue;
        const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map(a => a.getAttribute('href') || '');
        const href = links.find(h =>
          new RegExp('/' + handle + '/status/\\d+', 'i').test(h) &&
          !/analytics/i.test(h)
        );
        if (href) return 'https://x.com' + href.split('?')[0];
      }
      return null;
    }, { expectedNeedle: needle, handle: HANDLE });
    if (isConfirmedStatusUrl(match)) return match;
    if (attempt < attempts) console.log(`[thread] profile confirm miss ${attempt}/${attempts}`);
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DRAFT_PATH)) {
    console.log('[thread] no draft found — nothing to post');
    process.exit(0);
  }

  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf-8'));
  } catch (e) {
    console.error('[thread] invalid draft JSON:', e.message);
    process.exit(1);
  }

  const tweets = ['tweet1', 'tweet2', 'tweet3', 'tweet4'];
  for (const key of tweets) {
    if (!draft[key]) {
      console.error(`[thread] draft missing ${key}`);
      process.exit(1);
    }
  }

  // Voice-check all tweets
  for (const key of tweets) {
    const errors = voiceCheck(draft[key]);
    if (errors.length) {
      console.error(`[thread] voice rejects ${key}: ${errors.join('; ')}`);
      process.exit(1);
    }
  }

  console.log(`[thread] topic: ${draft.topic || '(none)'}`);
  for (const key of tweets) {
    console.log(`[thread] ${key} (${draft[key].length}c): ${draft[key].slice(0, 70)}…`);
  }

  const browser = await connectBrowser();
  const page = await getXPage(browser);
  const today = new Date().toISOString().slice(0, 10);
  const urls = {};

  try {
    // Post tweet1
    console.log('[thread] posting tweet1...');
    urls.tweet1 = await postTweet(page, draft.tweet1);
    if (!urls.tweet1) {
      console.error('[thread] tweet1 failed to confirm');
      process.exit(1);
    }
    console.log('[thread] tweet1 posted:', urls.tweet1);
    logTweet({ type: 'thread', content: draft.tweet1, tweet_url: urls.tweet1 });
    await humanDelay(4000, 7000);

    // Post tweet2 as reply to tweet1
    console.log('[thread] posting tweet2...');
    urls.tweet2 = await postReply(page, urls.tweet1, draft.tweet2);
    if (urls.tweet2) {
      console.log('[thread] tweet2 posted:', urls.tweet2);
      logTweet({ type: 'thread_reply', content: draft.tweet2, tweet_url: urls.tweet2, reply_to: urls.tweet1 });
    } else {
      console.log('[thread] tweet2 failed to confirm (tweet1 is still live)');
    }
    await humanDelay(4000, 7000);

    // Post tweet3 as reply to tweet2 (or tweet1 if tweet2 failed)
    const replyTo3 = urls.tweet2 || urls.tweet1;
    console.log('[thread] posting tweet3...');
    urls.tweet3 = await postReply(page, replyTo3, draft.tweet3);
    if (urls.tweet3) {
      console.log('[thread] tweet3 posted:', urls.tweet3);
      logTweet({ type: 'thread_reply', content: draft.tweet3, tweet_url: urls.tweet3, reply_to: replyTo3 });
    } else {
      console.log('[thread] tweet3 failed to confirm');
    }
    await humanDelay(4000, 7000);

    // Post tweet4 as reply to tweet3 (or fallback)
    const replyTo4 = urls.tweet3 || urls.tweet2 || urls.tweet1;
    console.log('[thread] posting tweet4...');
    urls.tweet4 = await postReply(page, replyTo4, draft.tweet4);
    if (urls.tweet4) {
      console.log('[thread] tweet4 posted:', urls.tweet4);
      logTweet({ type: 'thread_reply', content: draft.tweet4, tweet_url: urls.tweet4, reply_to: replyTo4 });
    } else {
      console.log('[thread] tweet4 failed to confirm');
    }

    fs.writeFileSync(STATE_PATH, JSON.stringify({
      last_posted: today,
      topic: draft.topic || null,
      tweet1_url: urls.tweet1,
    }, null, 2));

    try { fs.unlinkSync(DRAFT_PATH); } catch {}
    console.log('[thread] done');
    process.exit(0);

  } finally {
    await page.close().catch(() => {});
  }
}

main().catch(e => {
  console.error('[thread] fatal:', e.message);
  process.exit(1);
});
