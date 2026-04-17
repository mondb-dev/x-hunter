#!/usr/bin/env node
/**
 * runner/proactive_reply.js — proactive outbound reply engine
 *
 * Scans feed_digest.txt for high-engagement posts touching Sebastian's axes.
 * Picks the best candidate, verifies any factual claims via verify_one.js,
 * drafts a sharp reply via Gemini, posts via CDP.
 * Called from post_browse after each BROWSE cycle.
 *
 * Caps: max 4/day, min 60 min between replies.
 * Exit 0 = done (posted or skipped), exit 1 = fatal error.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { connectBrowser, getXPage } = require('./cdp');
const { isXSuppressed } = require('./lib/x_control');
const { buildPersona, buildCoreContext, recallForTopic, formatRecallHints } = require('./lib/sebastian_respond');
const { verifyClaim } = require('./lib/verify_claim');
const config = require('./lib/config');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(config.STATE_DIR, 'proactive_reply_state.json');
const INTERACTIONS = path.join(config.STATE_DIR, 'interactions.json');
const OWN_HANDLE = 'SebastianHunts';

const MAX_PER_DAY = 4;
const MIN_GAP_MS  = 60 * 60 * 1000;
const REPLY_BTN   = '[data-testid="reply"]';
const COMPOSE_BOX = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';

function log(msg) { console.log('[proactive_reply] ' + msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── State management ────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { replies_today: [], last_reply_at: null }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function canReply(state) {
  const today = new Date().toISOString().slice(0, 10);
  state.replies_today = (state.replies_today || []).filter(r => r.date === today);
  if (state.replies_today.length >= MAX_PER_DAY) {
    log('daily cap reached (' + state.replies_today.length + '/' + MAX_PER_DAY + ')');
    return false;
  }
  if (state.last_reply_at) {
    const elapsed = Date.now() - new Date(state.last_reply_at).getTime();
    if (elapsed < MIN_GAP_MS) {
      log('gap not met (' + Math.round(elapsed / 60000) + 'm/' + Math.round(MIN_GAP_MS / 60000) + 'm)');
      return false;
    }
  }
  return true;
}

// ── Digest parsing ──────────────────────────────────────────────────────────

function parseDigestForCandidates() {
  const digestPath = config.FEED_DIGEST_PATH;
  let raw;
  try { raw = fs.readFileSync(digestPath, 'utf-8'); }
  catch { log('no digest found'); return []; }

  const candidates = [];
  const lineRe = /@(\w+)\s+\[v([\d.]+)\s+T(\d+)\s+N([\d.]+)\]\s+"([^"]+)"\s+\[([\d.k]+)❤/g;
  let m;
  while ((m = lineRe.exec(raw)) !== null) {
    const handle = m[1];
    const velocity = parseFloat(m[2]);
    const trust = parseInt(m[3], 10);
    const novelty = parseFloat(m[4]);
    const text = m[5];
    let likes = m[6];

    if (likes.endsWith('k')) {
      likes = parseFloat(likes) * 1000;
    } else {
      likes = parseFloat(likes) || 0;
    }

    const afterMatch = raw.slice(m.index, m.index + 1000);
    const urlMatch = afterMatch.match(/https:\/\/x\.com\/\w+\/status\/\d+/);
    const url = urlMatch ? urlMatch[0] : null;

    if (!url) continue;
    if (handle.toLowerCase() === OWN_HANDLE.toLowerCase()) continue;
    if (likes < 200) continue;

    candidates.push({
      handle, text, url, likes, velocity, trust, novelty,
      score: likes * 0.4 + velocity * 0.3 + novelty * 100 * 0.3,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

// ── Axis relevance filter ───────────────────────────────────────────────────

function loadTopAxisKeywords() {
  try {
    const o = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf-8'));
    const axes = (o.axes || [])
      .filter(a => a.confidence >= 0.70)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);
    const keywords = [];
    for (const a of axes) {
      const words = (a.label + ' ' + a.left_pole + ' ' + a.right_pole)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 4);
      keywords.push(...words);
    }
    return [...new Set(keywords)];
  } catch { return []; }
}

function isAxisRelevant(text, keywords) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  return hits >= 1;
}

// ── Already engaged check ───────────────────────────────────────────────────

function alreadyEngaged(url) {
  try {
    const data = JSON.parse(fs.readFileSync(INTERACTIONS, 'utf-8'));
    const interactions = data.interactions || [];
    return interactions.some(i => i.tweet_url === url || i.source_url === url);
  } catch {}
  try {
    const state = loadState();
    return (state.replies_today || []).some(r => r.url === url);
  } catch {}
  return false;
}

// ── Gemini reply draft ──────────────────────────────────────────────────────

async function draftReply(candidate, verification) {
  const coreContext = buildCoreContext({
    maxAxes: 6,
    journalCount: 0,
    journalChars: 0,
    includeArticles: false,
    includeSprint: false,
  });

  // Recall past observations about this topic
  const recallHits = recallForTopic(candidate.text, 4);
  const recallBlock = recallHits.length > 0
    ? '\n\nYour past observations on this topic:\n' + formatRecallHints(recallHits) + '\n'
    : '';

  let verificationBlock = '';
  if (verification) {
    verificationBlock = '\n\nVERIFICATION RESULT (from Veritas Lens):\n' +
      'Verdict: ' + verification.verdict_label + ' (' + (verification.confidence * 100).toFixed(0) + '% confidence)\n' +
      'Summary: ' + (verification.summary || 'N/A') + '\n' +
      (verification.evidence_urls && verification.evidence_urls.length > 0
        ? 'Sources: ' + verification.evidence_urls.join(', ') + '\n'
        : '') +
      (verification.framing ? 'Framing: ' + verification.framing + '\n' : '') +
      'Lens: ' + verification.lens_url + '\n' +
      '\nUse this data to ground your reply in fact. If the post makes a claim that is ' +
      'refuted or unverified, say so directly. If supported, cite the evidence.\n';
  }

  const prompt = buildPersona('reply') + '\n\n' +
    coreContext +
    recallBlock +
    verificationBlock +
    '\n\nYou are proactively engaging with a post on X. This is outbound -- nobody asked you.\n' +
    'Your goal: insert Sebastian\'s voice into a high-visibility conversation.\n\n' +
    'The post:\n' +
    '  @' + candidate.handle + ': "' + candidate.text + '"\n' +
    '  (' + candidate.likes + ' likes)\n\n' +
    'Draft a reply (max 200 chars) that:\n' +
    '1. Takes a clear position -- agree, disagree, or add a specific nuance\n' +
    '2. References something concrete (a fact, a source, a contradiction you know about)\n' +
    '3. Is direct and confident. No hedging ("interesting point", "worth noting")\n' +
    '4. Sounds like a sharp person contributing, not a bot responding\n' +
    '5. Does NOT start with "I" -- lead with the substance\n' +
    (verification
      ? '6. If the claim is refuted or unverified, call it out with evidence. If supported, back it.\n'
      : '') +
    '\nBAD: "Great point about the tax system. Worth investigating further."\n' +
    'BAD: "This raises important questions about corporate accountability."\n' +
    'GOOD: "Zero in federal tax but $2.3B in lobbying spend. The money goes somewhere -- just not to the public."\n' +
    'GOOD: "Lavrov calling Russia a stabilizer while occupying Crimea. Words only work when the record is clean."\n\n' +
    'Return ONLY the reply text. Nothing else. If you cannot write something genuinely worth posting, return SKIP.';

  const { getAccessToken, getProjectConfig } = require('./gcp_auth');
  const { callGemini } = require('./lib/vertex_call');
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();

  const res = await callGemini({
    token,
    systemInstruction: buildPersona('reply'),
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    maxTokens: 300,
    temperature: 0.8,
    project,
    location,
  });

  const text = (res.text || '').trim();
  if (!text || text === 'SKIP' || text.length > 220) return null;
  return text;
}

// ── CDP reply posting ───────────────────────────────────────────────────────

async function postReplyViaCDP(page, tweetUrl, replyText) {
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
    catch { throw new Error('Reply button not found'); }
  }
  await sleep(2000);

  await page.waitForSelector(COMPOSE_BOX, { timeout: 10000 });
  await page.click(COMPOSE_BOX);
  await sleep(300);

  const inserted = await page.evaluate((txt, sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.focus();
    document.execCommand('insertText', false, txt);
    return el.textContent;
  }, replyText, COMPOSE_BOX);

  if (!inserted || inserted.length < replyText.length * 0.8) {
    await page.click(COMPOSE_BOX);
    await page.keyboard.type(replyText, { delay: 20 });
  }
  await sleep(800);

  await page.click(POST_BUTTON);
  await sleep(5000);

  log('reply posted to @' + tweetUrl.split('/')[3]);
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (isXSuppressed('reply')) {
    log('X reply suppression active — skipping');
    return;
  }

  const state = loadState();
  if (!canReply(state)) return;

  const candidates = parseDigestForCandidates();
  if (candidates.length === 0) {
    log('no high-engagement candidates in digest');
    return;
  }

  const keywords = loadTopAxisKeywords();
  const relevant = candidates.filter(c => isAxisRelevant(c.text, keywords));
  const pool = relevant.length > 0 ? relevant : candidates.slice(0, 3);

  const fresh = pool.filter(c => !alreadyEngaged(c.url));
  if (fresh.length === 0) {
    log('all candidates already engaged');
    return;
  }

  const target = fresh[0];
  log('target: @' + target.handle + ' (' + target.likes + ' likes) — ' +
      target.text.slice(0, 80));

  // ── Verify if the post contains a factual claim ──────────────────────
  let verification = null;
  if (target.text.length > 30) {
    log('verifying claim in target post...');
    verification = verifyClaim({
      claim: target.text,
      handle: target.handle,
      url: target.url,
    });
    if (verification) {
      log('verification: ' + verification.verdict_label +
        ' (' + (verification.confidence * 100).toFixed(0) + '%)');
    }
  }

  // Draft reply with verification context
  const replyText = await draftReply(target, verification);
  if (!replyText) {
    log('Gemini returned SKIP or empty — no reply this cycle');
    return;
  }
  log('drafted: ' + replyText.slice(0, 120));

  const browser = await connectBrowser();
  const page = await getXPage(browser);

  try {
    await postReplyViaCDP(page, target.url, replyText);

    const today = new Date().toISOString().slice(0, 10);
    state.replies_today.push({
      date: today,
      url: target.url,
      handle: target.handle,
      reply: replyText,
      verification: verification ? verification.verdict_label : null,
    });
    state.last_reply_at = new Date().toISOString();
    saveState(state);

    try {
      const data = JSON.parse(fs.readFileSync(INTERACTIONS, 'utf-8'));
      (data.interactions = data.interactions || []).push({
        type: 'proactive_reply',
        tweet_url: target.url,
        handle: target.handle,
        our_reply: replyText,
        verification: verification ? {
          status: verification.status,
          confidence: verification.confidence,
          lens_url: verification.lens_url,
        } : null,
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(INTERACTIONS, JSON.stringify(data, null, 2));
    } catch {}

    log('done');
  } finally {
    await page.close().catch(() => {});
  }
}

main().catch(e => {
  log('error: ' + e.message);
  process.exit(1);
});
