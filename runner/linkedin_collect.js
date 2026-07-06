#!/usr/bin/env node
'use strict';
/**
 * runner/linkedin_collect.js — feed LinkedIn into the belief pipeline, like X.
 *
 * Until now LinkedIn was only READ for engagement (linkedin_engage) and as a
 * minor content-pack signal — it never shaped Sebastian's beliefs. X does: the
 * scraper (collect.js) appends a scored digest block to feed_digest.txt, and the
 * BROWSE cycle (single_pass_browse.js) turns that digest into observations,
 * journal entries, and ontology deltas. This script does the LinkedIn analogue:
 * scrape the feed, score each post for relevance to Sebastian's themes, and
 * append a labeled LinkedIn block to the SAME feed_digest.txt — so the existing
 * browse→ontology→journal path absorbs LinkedIn exactly like X.
 *
 * Lightweight vs collect.js on purpose: no BigQuery / vision / clustering /
 * trust-graph (those are X-specific enrichments). Dedups via a seen-ledger.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1,
 *      LI_COLLECT_LIMIT (15), LI_COLLECT_MIN (1 = keep tangential+).
 */

const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const { HelmStackClient, LinkedIn } = require('../tools/helmstack-social/src');

const LEDGER = path.join(config.STATE_DIR, 'linkedin_collect_seen.json');
const DRY = process.env.HELMSTACK_DRY_RUN === '1';
const LIMIT = parseInt(process.env.LI_COLLECT_LIMIT || '15', 10);
const MIN_REL = parseInt(process.env.LI_COLLECT_MIN || '1', 10);
const log = (m) => console.log(`[linkedin_collect] ${m}`);

function loadLedger() { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, 'utf8')).keys); } catch { return new Set(); } }
function saveLedger(s) { try { fs.writeFileSync(LEDGER, JSON.stringify({ keys: [...s].slice(-800) }, null, 2)); } catch {} }
function keyFor(p) { return (p.permalink || '') || ((p.author || '') + ':' + (p.text || '').slice(0, 60)); }

// scrapeFeed often returns the whole listitem's innerText (author + connection
// degree + timestamp + "Follow" chrome, then the real post). Strip that chrome
// so beliefs form on the actual content, not LinkedIn UI. Best-effort.
function cleanText(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(/^(Feed post|Recommended for you|Promoted|Suggested|Follow)\b[\s:•\-]*/i, ''); } while (s !== prev);
  return s
    .replace(/•\s*(1st|2nd|3rd\+?|Following|Follow)\b/gi, ' ')
    .replace(/\b\d+\s*(h|m|d|w|mo|hr|hrs|min|mins)\b\s*•\s*(Edited\s*•\s*)?/gi, ' ')
    .replace(/\bEdited\b\s*•?\s*/gi, ' ')
    .replace(/\.\.\.\s*more$/i, '')
    .replace(/\s+/g, ' ').trim();
}
// Author: use scrapeFeed's if present, else the first name-like chunk before "•".
function deriveAuthor(p) {
  if (p.author && p.author.trim()) return p.author.replace(/\s+/g, ' ').trim();
  const head = String(p.text || '').replace(/^(Feed post|Recommended for you|Promoted|Suggested)\b[\s•\-]*/i, '').split('•')[0].trim();
  return head && head.length <= 60 ? head : '?';
}

// Relevance 0-3 (same rubric as x_engage/linkedin_engage). Stays on the local
// brain — cheap; this is a gate, not composition.
async function scoreRelevance(text) {
  try {
    const { generate } = require('./llm');
    const raw = await generate(
      `You rate a LinkedIn post for Sebastian Hunter, who maps how narratives are constructed in public discourse (political messaging, media framing, propaganda, institutional accountability, information integrity).\n` +
      `Rate ONLY substantive relevance to those themes; job updates/congrats/motivational/personal/ads = 0.\n` +
      `Single digit: 0=irrelevant,1=tangential,2=relevant,3=on-topic.\n\nPOST: "${text.slice(0, 400)}"\n\nDigit:`,
      { temperature: 0, maxTokens: 5, timeoutMs: 30_000 }
    );
    const m = String(raw).match(/[0-3]/);
    return m ? Number(m[0]) : 0;
  } catch { return 1; } // LLM down → keep as tangential
}

(async () => {
  if (!process.env.HELMSTACK_AUTH_TOKEN) { log('no HELMSTACK_AUTH_TOKEN — skipping'); process.exit(0); }
  const li = new LinkedIn(new HelmStackClient(), { ownHandleHint: 'sebastian hunter', log: () => {} });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log('LinkedIn session not present — skipping'); process.exit(0); }
  } catch (e) { log(`cannot reach HelmStack/LinkedIn: ${e.message}`); process.exit(0); }

  let feed = [];
  try { feed = await li.scrapeFeed({ limit: LIMIT }); } catch (e) { log(`scrape failed: ${e.message}`); process.exit(0); }
  log(`scraped ${feed.length} post(s)`);

  const seen = loadLedger();
  const fresh = feed.filter((p) => (p.text || '').trim().length > 40 && !seen.has(keyFor(p)));
  if (!fresh.length) { log('no fresh posts'); process.exit(0); }

  const kept = [];
  for (const p of fresh) {
    const rel = await scoreRelevance(cleanText(p.text));
    if (rel >= MIN_REL) kept.push({ ...p, rel });
    seen.add(keyFor(p));
  }
  log(`${kept.length} relevant (>=${MIN_REL}) of ${fresh.length} fresh`);
  if (!kept.length) { if (!DRY) saveLedger(seen); process.exit(0); }

  // Append a labeled block to the SAME digest the browse cycle reads.
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const lines = [
    '',
    `── ${now} ── LINKEDIN (${kept.length} posts) ${'─'.repeat(20)}`,
    '    SOURCE: LinkedIn feed (professional discourse — media/policy/tech/info-integrity)',
    '',
  ];
  for (const p of kept.sort((a, b) => b.rel - a.rel)) {
    const author = deriveAuthor(p);
    const text = cleanText(p.text).slice(0, 400);
    const url = p.permalink || '';
    lines.push(`  [LI rel=${p.rel}] ${author}: ${text}${url ? ` (${url})` : ''}`);
  }
  const block = lines.join('\n');

  if (DRY) { log('DRY RUN — not appending. Block preview:'); console.log(block); process.exit(0); }
  fs.appendFileSync(config.FEED_DIGEST_PATH, block + '\n');
  saveLedger(seen);
  log(`appended ${kept.length} LinkedIn post(s) to feed_digest — browse cycle will absorb into beliefs`);
  process.exit(0);
})().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
