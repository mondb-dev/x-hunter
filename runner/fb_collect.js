#!/usr/bin/env node
'use strict';
/**
 * runner/fb_collect.js — feed Facebook into the belief pipeline (parity with X /
 * LinkedIn). Scrapes a rotating subset of curated public PH Pages (lib/fb_sources),
 * scores each post for narrative relevance, and appends a labeled block to the
 * SAME feed_digest.txt the BROWSE cycle reads → observations/journal/ontology.
 *
 * Rotates FB_MAX_PAGES per run (offset persisted) so runtime stays bounded and
 * load is spread; dedups posts by permalink via a seen-ledger.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1,
 *      FB_MAX_PAGES (4/run), FB_POSTS_PER_PAGE (5), FB_COLLECT_MIN (1).
 */

const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const SOURCES = require('./lib/fb_sources');
const { HelmStackClient, FB } = require('../tools/helmstack-social/src');

const LEDGER = path.join(config.STATE_DIR, 'fb_collect_seen.json');
const DRY = process.env.HELMSTACK_DRY_RUN === '1';
const MAX_PAGES = parseInt(process.env.FB_MAX_PAGES || '4', 10);
const PER_PAGE = parseInt(process.env.FB_POSTS_PER_PAGE || '5', 10);
const MIN_REL = parseInt(process.env.FB_COLLECT_MIN || '1', 10);
const log = (m) => console.log(`[fb_collect] ${m}`);

function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { keys: [], offset: 0 }; } }
function saveLedger(l) { try { fs.writeFileSync(LEDGER, JSON.stringify({ keys: l.keys.slice(-1200), offset: l.offset }, null, 2)); } catch {} }

// FB post text is cleaner than LinkedIn cards, but trim stray reaction/see-more chrome.
function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ')
    .replace(/\bSee more$/i, '').replace(/\bSee translation$/i, '')
    .replace(/\bAll reactions:.*$/i, '').trim();
}

async function scoreRelevance(text) {
  try {
    const { generate } = require('./llm');
    const raw = await generate(
      `You rate a Facebook post for Sebastian Hunter, who maps how narratives are constructed in public discourse (political messaging, media framing, propaganda, institutional accountability, information integrity) — especially in the Philippines.\n` +
      `Rate ONLY substantive relevance to those themes; sports scores, entertainment, promos, weather, personal = 0.\n` +
      `Single digit: 0=irrelevant,1=tangential,2=relevant,3=on-topic.\n\nPOST: "${text.slice(0, 400)}"\n\nDigit:`,
      { temperature: 0, maxTokens: 5, timeoutMs: 30_000 }
    );
    const m = String(raw).match(/[0-3]/);
    return m ? Number(m[0]) : 0;
  } catch { return 1; }
}

(async () => {
  if (!process.env.HELMSTACK_AUTH_TOKEN) { log('no HELMSTACK_AUTH_TOKEN — skipping'); process.exit(0); }
  const fb = new FB(new HelmStackClient(), { ownName: 'Sebastian Hunter', log: () => {} });
  try {
    await fb.ensureTab();
    if (!(await fb.sessionOk())) { log('FB session not present (login required) — skipping'); process.exit(0); }
  } catch (e) { log(`cannot reach HelmStack/FB: ${e.message}`); process.exit(0); }

  const ledger = loadLedger();
  const seen = new Set(ledger.keys);
  // Rotate through the source list so each run only hits MAX_PAGES.
  const start = ledger.offset % SOURCES.length;
  const batch = [];
  for (let i = 0; i < Math.min(MAX_PAGES, SOURCES.length); i++) batch.push(SOURCES[(start + i) % SOURCES.length]);
  ledger.offset = (start + batch.length) % SOURCES.length;
  log(`scraping ${batch.length}/${SOURCES.length} pages: ${batch.map((s) => s.name).join(', ')}`);

  const kept = [];
  for (const src of batch) {
    let posts = [];
    try { posts = await fb.scrapePage(src.url, { limit: PER_PAGE }); } catch (e) { log(`${src.name}: scrape failed (${e.message})`); continue; }
    const fresh = posts.filter((p) => p.permalink && (p.text || '').trim().length > 20 && !seen.has(p.permalink));
    for (const p of fresh) {
      seen.add(p.permalink);
      const text = cleanText(p.text);
      const rel = await scoreRelevance(text);
      if (rel >= MIN_REL) kept.push({ page: src.name, text, url: p.permalink, rel });
    }
    log(`${src.name}: ${posts.length} scraped, ${fresh.length} fresh`);
  }

  log(`${kept.length} relevant (>=${MIN_REL}) post(s) across batch`);
  if (!kept.length) { if (!DRY) saveLedger({ keys: [...seen], offset: ledger.offset }); process.exit(0); }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const lines = [
    '',
    `── ${now} ── FACEBOOK (${kept.length} posts) ${'─'.repeat(20)}`,
    '    SOURCE: Facebook — curated PH news / fact-checkers / investigative pages',
    '',
  ];
  for (const p of kept.sort((a, b) => b.rel - a.rel)) {
    lines.push(`  [FB rel=${p.rel}] ${p.page}: ${p.text.slice(0, 400)} (${p.url})`);
  }
  const block = lines.join('\n');

  if (DRY) { log('DRY RUN — not appending. Block preview:'); console.log(block); process.exit(0); }
  fs.appendFileSync(config.FEED_DIGEST_PATH, block + '\n');
  saveLedger({ keys: [...seen], offset: ledger.offset });
  log(`appended ${kept.length} FB post(s) to feed_digest — browse cycle will absorb into beliefs`);
  process.exit(0);
})().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
