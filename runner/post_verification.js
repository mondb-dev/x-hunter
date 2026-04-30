#!/usr/bin/env node
/**
 * runner/post_verification.js — select a claim to post about and write a draft
 *
 * Called from runner/lib/post_browse.js after signal_detector.js.
 * Writes state/verification_draft.txt (quote_draft format: line 1 = URL to quote,
 * rest = commentary) and state/verification_meta.json so the caller can update
 * the DB with the resulting tweet URL after posting.
 *
 * Priority:
 *   1. Resolution post — verdict reached (supported/refuted), confidence ≥ 0.65,
 *      watch tweet URL exists, resolution not yet posted.
 *   2. Watch signal — new unverified claim with a quotable source, confidence ≥ 0.45.
 *
 * Caps: 1 verification post per day total (watch OR resolution).
 * Active hours only: UTC 07–23.
 * Silently exits (no draft written) when cap is hit or no candidates exist.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { loadVerificationDb } = require('./lib/db_backend');

const ROOT      = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const DRAFT     = path.join(STATE_DIR, 'verification_draft.txt');
const META      = path.join(STATE_DIR, 'verification_meta.json');
const POSTS_LOG = path.join(STATE_DIR, 'posts_log.json');

const HOUR_UTC  = new Date().getUTCHours();
const TWEET_START = 7;
const TWEET_END   = 23;
const MAX_CLAIM_TEXT_CHARS  = 120;
const MAX_SUMMARY_CHARS     = 180;

function log(...args) { console.log('[post_verification]', ...args); }

// ── Daily cap check ──────────────────────────────────────────────────────────
function verificationPostsToday() {
  try {
    const data = JSON.parse(fs.readFileSync(POSTS_LOG, 'utf-8'));
    const posts = Array.isArray(data) ? data : (data.posts || []);
    const today = new Date().toISOString().slice(0, 10);
    return posts.filter(p =>
      (p.type === 'verification_watch' || p.type === 'verification_resolution') &&
      (p.posted_at || '').startsWith(today)
    ).length;
  } catch { return 0; }
}

// ── Text helpers ─────────────────────────────────────────────────────────────
function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function firstSentence(str) {
  if (!str) return '';
  const m = str.match(/^[^.!?]+[.!?]/);
  return m ? m[0] : str.split('\n')[0];
}

// ── Draft builders ───────────────────────────────────────────────────────────
function isValidUrl(str) {
  return typeof str === 'string' && (str.startsWith('https://') || str.startsWith('http://'));
}

function buildWatchDraft(claim, today, hour) {
  const claim_text = truncate(claim.claim_text, MAX_CLAIM_TEXT_CHARS);
  const journalUrl = `https://sebastianhunter.fun/journal/${today}/${hour}`;
  // Quote the original source tweet only if original_source is a real URL;
  // fall back to an X search so the quote-tweet mechanism still works.
  const quoteUrl = isValidUrl(claim.original_source)
    ? claim.original_source
    : `https://x.com/search?q=${encodeURIComponent(claim.claim_text.slice(0, 60))}`;
  const commentary = `Unverified claim circulating: "${claim_text}" — I'm tracking this.`;
  return { quoteUrl, commentary, journalUrl };
}

function buildResolutionDraft(claim, today, hour) {
  const journalUrl = `https://sebastianhunter.fun/journal/${today}/${hour}`;
  const verdict = claim.status === 'supported' ? 'Supported' : 'Refuted';
  const confidence = Math.round((claim.confidence_score || 0) * 100);
  const finding = truncate(firstSentence(claim.web_search_summary || ''), MAX_SUMMARY_CHARS);
  const commentary = finding
    ? `Update: ${verdict} (${confidence}% confidence). ${finding}`
    : `Update: ${verdict} (${confidence}% confidence).`;
  return { quoteUrl: claim.watch_tweet_url, commentary, journalUrl };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // Clean up stale drafts from previous cycles
  try { fs.unlinkSync(DRAFT); } catch {}
  try { fs.unlinkSync(META);  } catch {}

  // Active hours only
  if (HOUR_UTC < TWEET_START || HOUR_UTC >= TWEET_END) {
    log(`outside active hours (UTC ${HOUR_UTC}) — skipping`);
    process.exit(0);
  }

  // Daily cap
  const todayCount = verificationPostsToday();
  if (todayCount >= 1) {
    log(`daily cap reached (${todayCount}/1) — skipping`);
    process.exit(0);
  }

  let vdb;
  try { vdb = loadVerificationDb(); }
  catch (e) { log('verification DB unavailable:', e.message); process.exit(0); }

  const today = new Date().toISOString().slice(0, 10);
  const hour  = String(new Date().getUTCHours()).padStart(2, '0');

  // ── Priority 1: Resolution ─────────────────────────────────────────────
  const resolutions = typeof vdb.getResolutionCandidates === 'function'
    ? vdb.getResolutionCandidates()
    : [];

  if (resolutions.length > 0) {
    const claim = resolutions[0];
    const { quoteUrl, commentary, journalUrl } = buildResolutionDraft(claim, today, hour);
    const draftText = `${quoteUrl}\n${commentary}\n${journalUrl}\n`;

    // Guard: commentary must fit within 240 chars (embed takes ~23 via t.co)
    if (commentary.length > 240) {
      log(`resolution draft too long (${commentary.length}) — skipping`);
    } else {
      fs.writeFileSync(DRAFT, draftText, 'utf-8');
      fs.writeFileSync(META, JSON.stringify({ claim_id: claim.claim_id, type: 'resolution' }));
      log(`wrote resolution draft for ${claim.claim_id}: ${claim.status} (${Math.round(claim.confidence_score * 100)}%)`);
      process.exit(0);
    }
  }

  // ── Priority 2: Watch signal ──────────────────────────────────────────
  const watches = typeof vdb.getWatchCandidates === 'function'
    ? vdb.getWatchCandidates()
    : [];

  if (watches.length === 0) {
    log('no candidates — skipping');
    process.exit(0);
  }

  const claim = watches[0];
  const { quoteUrl, commentary, journalUrl } = buildWatchDraft(claim, today, hour);

  if (commentary.length > 240) {
    log(`watch draft too long (${commentary.length}) — skipping`);
    process.exit(0);
  }

  const draftText = `${quoteUrl}\n${commentary}\n${journalUrl}\n`;
  fs.writeFileSync(DRAFT, draftText, 'utf-8');
  fs.writeFileSync(META, JSON.stringify({ claim_id: claim.claim_id, type: 'watch' }));
  log(`wrote watch draft for ${claim.claim_id}: "${claim.claim_text.slice(0, 60)}"`);
})().catch(e => {
  log('error:', e.message);
  process.exit(0);
});
