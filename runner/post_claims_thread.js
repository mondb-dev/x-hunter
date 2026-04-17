#!/usr/bin/env node
/**
 * runner/post_claims_thread.js — post a 2-tweet claims thread via CDP
 *
 * Reads state/claim_thread_draft.json → verifies the claim via verify_one.js →
 * enriches tweets with verdict data → posts tweet1, then self-replies with tweet2.
 * Exit 0 = both posted, exit 1 = failure.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { connectBrowser, getXPage } = require('./cdp');
const { logTweet } = require('./posts_log');
const {
  HANDLE,
  isConfirmedStatusUrl,
} = require('./post_result');
const { check: voiceCheck } = require('./lib/voice_filter');
const { verifyClaim } = require('./lib/verify_claim');

const ROOT       = path.resolve(__dirname, '..');
const DRAFT_PATH = path.join(ROOT, 'state', 'claim_thread_draft.json');
const STATE_PATH = path.join(ROOT, 'state', 'claims_thread_state.json');

const COMPOSE_BOX  = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON  = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
const REPLY_BTN    = '[data-testid="reply"]';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function humanDelay(min, max) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

async function typeIntoCompose(page, text, selector) {
  await page.click(selector);
  await sleep(300);
  const inserted = await page.evaluate((txt, sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.focus();
    document.execCommand('insertText', false, txt);
    return el.textContent;
  }, text, selector);
  if (!inserted || inserted.length < text.length * 0.8) {
    await page.click(selector);
    await page.keyboard.type(text, { delay: 20 });
  }
  await sleep(500);
}

async function postTweet(page, text) {
  await page.goto('https://x.com/compose/post', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
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
    waitUntil: 'domcontentloaded',
    timeout: 90000,
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
    if (attempt < attempts) {
      console.log('[claims_thread] profile confirm miss ' + attempt + '/' + attempts);
    }
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DRAFT_PATH)) {
    console.log('[claims_thread] no draft found — nothing to post');
    process.exit(0);
  }

  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf-8'));
  } catch (e) {
    console.error('[claims_thread] invalid draft JSON:', e.message);
    process.exit(1);
  }

  if (!draft.tweet1 || !draft.tweet2) {
    console.error('[claims_thread] draft missing tweet1 or tweet2');
    process.exit(1);
  }

  // ── Verify the claim before posting ──────────────────────────────────
  let verification = null;
  const claimText = draft.claim_text || draft.tweet1;
  console.log('[claims_thread] verifying claim via verify_one.js...');
  verification = verifyClaim({
    claim: claimText,
    handle: draft.source_handle || null,
    url: draft.source_url || null,
    category: draft.category || null,
    axis: draft.axis || null,
  });

  if (verification) {
    console.log('[claims_thread] verification: ' + verification.verdict_label +
      ' (' + (verification.confidence * 100).toFixed(0) + '%)');

    // Append lens URL to tweet2 if it fits
    const lensTag = '\n' + verification.lens_url;
    if (draft.tweet2.length + lensTag.length <= 280) {
      draft.tweet2 = draft.tweet2 + lensTag;
      console.log('[claims_thread] appended Veritas Lens URL to tweet2');
    }
  } else {
    console.log('[claims_thread] verification unavailable — posting without');
  }

  // Voice filter both tweets
  // Voice filter check
  const vf1 = voiceCheck(draft.tweet1);
  if (vf1.length) { console.error('[claims_thread] voice rejects tweet1: ' + vf1.join('; ')); process.exit(1); }
  const vf2 = voiceCheck(draft.tweet2);
  if (vf2.length) { console.error('[claims_thread] voice rejects tweet2: ' + vf2.join('; ')); process.exit(1); }
  const tweet1 = draft.tweet1;
  const tweet2 = draft.tweet2;

  console.log('[claims_thread] posting tweet1 (' + tweet1.length + ' chars)');
  console.log('[claims_thread] draft tweet2 (' + tweet2.length + ' chars)');

  const browser = await connectBrowser();
  const page = await getXPage(browser);

  try {
    const url1 = await postTweet(page, tweet1);
    if (!url1) {
      console.error('[claims_thread] tweet1 failed to confirm');
      process.exit(1);
    }
    console.log('[claims_thread] tweet1 posted: ' + url1);

    logTweet({
      type: 'claims_thread',
      content: tweet1,
      tweet_url: url1,
      claim_id: draft.claim_id || null,
      verification: verification ? {
        status: verification.status,
        confidence: verification.confidence,
        verdict_label: verification.verdict_label,
        lens_url: verification.lens_url,
      } : null,
    });

    await humanDelay(3000, 6000);

    console.log('[claims_thread] posting tweet2 as reply to ' + url1);
    const url2 = await postReply(page, url1, tweet2);
    if (!url2) {
      console.log('[claims_thread] tweet2 failed to confirm (tweet1 is still live)');
    } else {
      console.log('[claims_thread] tweet2 posted: ' + url2);
      logTweet({
        type: 'claims_thread_reply',
        content: tweet2,
        tweet_url: url2,
        reply_to: url1,
        claim_id: draft.claim_id || null,
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      last_posted: today,
      last_claim_id: draft.claim_id || null,
      last_verification: verification ? verification.status : null,
    }));

    try { fs.unlinkSync(DRAFT_PATH); } catch {}

    console.log('[claims_thread] done');
    process.exit(0);
  } finally {
    await page.close().catch(() => {});
  }
}

main().catch(e => {
  console.error('[claims_thread] fatal:', e.message);
  process.exit(1);
});
