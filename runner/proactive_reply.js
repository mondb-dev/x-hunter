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
const { buildPersona, buildCoreContext } = require('./lib/sebastian_respond');
const { verifyClaim } = require('./lib/verify_claim');
const config = require('./lib/config');

// Postgres interactions store (optional — non-fatal if unavailable)
let interactionsDb = null;
try { interactionsDb = require('./intelligence/interactions_db.pg'); } catch {}

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(config.STATE_DIR, 'proactive_reply_state.json');
const INTERACTIONS = path.join(config.STATE_DIR, 'interactions.json');
const OWN_HANDLE = 'SebastianHunts';

const MAX_PER_DAY = 8;
const MIN_GAP_MS  = 30 * 60 * 1000;
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

    // Lower threshold for factual claim posts (numbers, stats, attributions, quotes)
    const isFactualClaim = /\d+%|\$[\d.]+[BMK]?|\d+[\s,]\d{3}|said|claims?|according|report|study|data|source/.test(text);
    const minLikes = isFactualClaim ? 50 : 200;
    if (likes < minLikes) continue;

    candidates.push({
      handle, text, url, likes, velocity, trust, novelty, isFactualClaim,
      score: likes * 0.4 + velocity * 0.3 + novelty * 100 * 0.3 + (isFactualClaim ? 50 : 0),
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

  const recallBlock = '';  // recallForTopic removed — memory API handles recall


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
      '\nCRITICAL GROUNDING RULES:\n' +
      '- "Refuted" means the claim is PROVEN FALSE by evidence. You may correct it with the counter-evidence above.\n' +
      '- "Unverified" means we COULD NOT CONFIRM OR DENY the claim. This is NOT the same as false.\n' +
      '  Do NOT say a claim is wrong just because it is unverified. You do not have enough evidence.\n' +
      '- "Supported" means the claim checks out. You may cite the evidence.\n' +
      '- NEVER fabricate corrections. Only correct claims when you have specific counter-evidence from the sources above.\n';
  }

  const prompt = buildPersona('reply') + '\n\n' +
    coreContext +
    recallBlock +
    verificationBlock +
    '\n\nYou are proactively engaging with a post on X. This is outbound -- nobody asked you.\n' +
    'Your goal: insert Sebastian\'s voice into a high-visibility conversation, especially to correct\n' +
    'wrong claims with solid evidence from your research and investigations.\n\n' +
    'The post:\n' +
    '  @' + candidate.handle + ': "' + candidate.text + '"\n' +
    '  (' + candidate.likes + ' likes' + (candidate.isFactualClaim ? ', contains factual claim' : '') + ')\n\n' +
    'Draft a reply (max 260 chars) that:\n' +
    '1. PRIORITY: If the verification says REFUTED, correct the claim using the specific counter-evidence provided.\n' +
    '   Lead with the correct information. Name the source. Be direct.\n' +
    '   If the verification says UNVERIFIED, do NOT claim the post is wrong. Instead, add context, a related\n' +
    '   observation, or engage with the topic — but NEVER assert something is false without evidence.\n' +
    '2. If the claim is supported, add what supports it or what context makes it more precise.\n' +
    '3. If there is nothing factual to correct or confirm, take a clear position with a specific detail.\n' +
    '4. Is direct and confident. No hedging ("interesting point", "worth noting", "raises questions").\n' +
    '5. Sounds like a sharp person contributing, not a bot responding. No filler.\n' +
    '6. Does NOT start with "I" — lead with the substance or the fact.\n' +
    (verification
      ? '7. Use the verification evidence. If REFUTED, say so with counter-evidence. If UNVERIFIED, do NOT fabricate corrections.\n'
      : '') +
    '\nBAD: "Great point about the tax system. Worth investigating further."\n' +
    'BAD: "This raises important questions about corporate accountability."\n' +
    'GOOD: "Zero in federal tax but $2.3B in lobbying spend. The money goes somewhere -- just not to the public."\n' +
    'GOOD: "Lavrov calling Russia a stabilizer while occupying Crimea. Words only work when the record is clean."\n' +
    'GOOD: "That number is wrong. IMF data shows 2.1%, not 4.3%. The report they cited was from 2019."\n\n' +
    'Return ONLY the reply text. Nothing else. If you cannot write something genuinely worth posting, return SKIP.';

  const { getAccessToken, getProjectConfig } = require('./gcp_auth');
  const { callGemini } = require('./lib/sebastian_respond');
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();

  const res = await callGemini({
    token,
    systemInstruction: buildPersona('reply'),
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    maxTokens: 300,
    temperature: 0.8,
    project,
    location,
  });

  const text = (res.text || '').trim();
  if (!text || text === 'SKIP' || text.length > 270) return null;

  // Extract grounding URLs from Vertex response for source citation
  // Filter out vertexaisearch redirect URLs — they are internal Google redirects, not real sources
  const groundingChunks = res.raw?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sourceUrls = groundingChunks
    .filter(c => c.web?.uri && !c.web.uri.includes('vertexaisearch.cloud.google.com'))
    .map(c => c.web.uri)
    .slice(0, 3);

  return { text, sourceUrls };
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

  await page.evaluate((txt, sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    document.execCommand('insertText', false, txt);
  }, replyText, COMPOSE_BOX);
  await sleep(1200); // wait for React to process the DOM mutation

  const inserted = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.trim() : '';
  }, COMPOSE_BOX);

  if (!inserted || inserted.length < replyText.length * 0.9) {
    log(`reply text truncated: ${inserted.length}/${replyText.length} chars — retrying with keyboard`);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); }
    }, COMPOSE_BOX);
    await sleep(1000);
    // Verify box is cleared
    const cleared = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.trim() : '';
    }, COMPOSE_BOX);
    if (cleared.length > 0) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.innerHTML = '';
      }, COMPOSE_BOX);
      await sleep(500);
    }
    // Re-focus before typing
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.click(); el.focus(); }
    }, COMPOSE_BOX);
    await sleep(800);
    await page.keyboard.type(replyText, { delay: 20 });
    await sleep(1200);
    // Verify retry
    const retryText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.trim() : '';
    }, COMPOSE_BOX);
    const firstMatch = retryText.substring(0, 20) === replyText.substring(0, 20);
    if (!retryText || retryText.length < replyText.length * 0.95 || !firstMatch) {
      throw new Error(`Reply text insertion failed after retry: got ${retryText.length}/${replyText.length} chars, first20=${firstMatch}`);
    }
  }

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

  // Gate: skip if verification is "unverified" with low confidence — not enough signal to engage
  if (verification && verification.status === 'unverified' && verification.confidence < 0.4) {
    log('verification too weak to engage (' + verification.verdict_label + ' at ' +
      (verification.confidence * 100).toFixed(0) + '%) — risk of hallucinated correction');
    return;
  }

  // Draft reply with verification context
  const draft = await draftReply(target, verification);
  if (!draft) {
    log('Gemini returned SKIP or empty — no reply this cycle');
    return;
  }

  // Build reply text: append one source URL if it fits (X shortens to ~23 chars via t.co)
  let replyText = draft.text;
  let citedUrl = null;
  if (draft.sourceUrls && draft.sourceUrls.length > 0 && replyText.length <= 247) {
    citedUrl = draft.sourceUrls[0];
    replyText = replyText + '\n' + citedUrl;
  }
  log('drafted: ' + replyText.slice(0, 120) +
    (citedUrl ? ' [+source]' : '') +
    (draft.sourceUrls.length > 0 ? ` (${draft.sourceUrls.length} grounding URLs)` : ''));

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
      source_urls: draft.sourceUrls || [],
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
        source_urls: draft.sourceUrls || [],
        verification: verification ? {
          status: verification.status,
          confidence: verification.confidence,
          lens_url: verification.lens_url,
        } : null,
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(INTERACTIONS, JSON.stringify(data, null, 2));
    } catch {}

    // Mirror to Postgres (fire-and-forget)
    if (interactionsDb && process.env.DATABASE_URL) {
      interactionsDb.insertInteraction({
        tweet_id:       (target.url || '').split('/').pop() || null,
        type:           'proactive',
        from_username:  target.handle ? target.handle.replace(/^@/, '') : 'unknown',
        their_text:     target.text || null,
        our_reply:      replyText,
        memory_used:    [],
        interaction_at: new Date().toISOString(),
      }).catch(e => console.warn('[proactive_reply] interactions_db write failed:', e.message));
    }

    log('done');
  } finally {
    await page.close().catch(() => {});
  }
}

main().catch(e => {
  log('error: ' + e.message);
  process.exit(1);
});
