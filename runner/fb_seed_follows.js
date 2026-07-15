#!/usr/bin/env node
'use strict';
/**
 * runner/fb_seed_follows.js — follow curated PH Pages (lib/fb_sources) AND public
 * figures / creators (lib/fb_figures) so Sebastian's HOME feed populates over time
 * (approach A), complementing the direct page scraping in fb_collect.js (approach B).
 *
 * Follows are an automated action with a small ban surface, so this is deliberately
 * slow (long human-ish gaps) and capped per run (FB_FOLLOW_MAX). A ledger records
 * which targets we've already followed so re-runs skip them and only pick up newly
 * added Pages/figures — safe to run on a recurring schedule.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1 (locate button, don't
 *      click), FB_FOLLOW_MAX (6 per run), FB_FOLLOW_GAP_MS (20000).
 * Run: node runner/fb_seed_follows.js
 */

const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const SOURCES = require('./lib/fb_sources');
const FIGURES = require('./lib/fb_figures');
const { HelmStackClient, FB } = require('../tools/helmstack-social/src');

const LEDGER = path.join(config.STATE_DIR, 'fb_followed.json');
const DRY = process.env.HELMSTACK_DRY_RUN === '1';
const MAX_PER_RUN = parseInt(process.env.FB_FOLLOW_MAX || '6', 10); // cap follows/run (ban surface)
const GAP_MS = parseInt(process.env.FB_FOLLOW_GAP_MS || '20000', 10); // ~20s between follows
const log = (m) => console.log(`[fb_seed_follows] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadFollowed() { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, 'utf8')).urls); } catch { return new Set(); } }
function saveFollowed(s) { try { fs.writeFileSync(LEDGER, JSON.stringify({ urls: [...s] }, null, 2)); } catch {} }

(async () => {
  if (!process.env.HELMSTACK_AUTH_TOKEN) { log('no HELMSTACK_AUTH_TOKEN — skipping'); process.exit(0); }
  const fb = new FB(new HelmStackClient(), { ownName: 'Sebastian Hunter', log });
  try {
    await fb.ensureTab();
    if (!(await fb.sessionOk())) { log('FB session not present (login required) — skipping'); process.exit(0); }
  } catch (e) { log(`cannot reach HelmStack/FB: ${e.message}`); process.exit(0); }

  const followed = loadFollowed();
  const all = [...SOURCES, ...FIGURES];
  const todo = all.filter((s) => !followed.has(s.url)).slice(0, MAX_PER_RUN);
  log(`${todo.length} target(s) this run (${followed.size}/${all.length} already done, cap ${MAX_PER_RUN})${DRY ? ' [dry-run]' : ''}`);

  let ok = 0;
  for (let i = 0; i < todo.length; i++) {
    const src = todo[i];
    try {
      const res = await fb.followPage(src.url, { dryRun: DRY });
      if (res.dryRun) { log(`${src.name}: follow button located (dry-run)`); }
      else if (res.ok) { log(`${src.name}: followed`); followed.add(src.url); saveFollowed(followed); ok++; }
      else { log(`${src.name}: ${res.reason}`); }
    } catch (e) { log(`${src.name}: error ${e.message}`); }
    if (i < todo.length - 1) await sleep(GAP_MS); // pace to reduce ban surface
  }
  log(`done — ${ok} newly followed${DRY ? ' (dry-run, none actually followed)' : ''}`);
  await fb.c.navigate(fb.tab, 'https://www.facebook.com/').catch(() => {});
  process.exit(0);
})().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
