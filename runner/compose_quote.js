#!/usr/bin/env node
'use strict';
/**
 * runner/compose_quote.js — compose a single quote-tweet draft directly, without
 * the agentic gemini_agent loop (parallel to compose_tweet.js).
 *
 * WHY: the QUOTE cycle runs `agentRun({ agent: 'x-hunter' })` on local qwen to
 * pick a candidate from the feed digest, read it, and write state/quote_draft.txt
 * — and it routinely finishes without emitting the file (no_draft). The quote
 * prompt's candidates come from the pre-scraped FEED DIGEST (which carries the
 * tweet text + URL), so selection + commentary is a single-shot compose job.
 *
 * Output written to state/quote_draft.txt in the runner's expected format:
 *   Line 1: the source tweet URL
 *   Line 2+: the quote commentary (<=240 chars)
 *
 * SAFE FALLBACK: no-op if a non-empty, non-SKIP draft already exists.
 * Runs the shared fact-check gate before writing (voice + critique run later in
 * the post pipeline via postQuoteTweet).
 *
 * Run: node runner/compose_quote.js   (honors CYCLE/DAY_NUMBER/TODAY/NOW/HOUR env)
 */

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const config = require('./lib/config');

if (fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const loadContext      = require('./lib/prompts/context');
const buildQuotePrompt = require('./lib/prompts/quote');
const { compose }      = require('./lib/compose');
const { passOutbound } = require('./lib/outbound_gates');

const DRAFT_PATH = config.QUOTE_DRAFT_PATH || path.join(config.STATE_DIR, 'quote_draft.txt');
const log = (m) => console.log(`[compose_quote] ${m}`);

function currentCycle() {
  try { return JSON.parse(fs.readFileSync(path.join(config.STATE_DIR, 'cycle_counter.json'), 'utf-8')).cycle; }
  catch { return 1; }
}
function dayNumberFrom(today) {
  try {
    const start = new Date(config.AGENT_START_DATE + 'T00:00:00Z');
    return Math.max(1, Math.floor((new Date(today + 'T00:00:00Z') - start) / 86400000) + 1);
  } catch { return 1; }
}

(async () => {
  // Don't clobber a draft the agent already wrote.
  try {
    const existing = fs.readFileSync(DRAFT_PATH, 'utf-8').trim();
    const line1 = existing.split('\n')[0].trim();
    if (line1 && line1.toUpperCase() !== 'SKIP') { log('draft already present — leaving it'); process.exit(0); }
  } catch { /* no draft — proceed */ }

  const nowDate = new Date();
  const today = process.env.TODAY || nowDate.toISOString().slice(0, 10);
  const hour  = process.env.HOUR  || String(nowDate.getHours()).padStart(2, '0');
  const now   = process.env.NOW   || nowDate.toTimeString().slice(0, 5);
  const cycle = parseInt(process.env.CYCLE_NUMBER || process.env.CYCLE || '', 10) || currentCycle();
  const dayNumber = parseInt(process.env.DAY_NUMBER || '', 10) || dayNumberFrom(today);

  let ctx;
  try { ctx = loadContext({ type: 'quote', cycle, dayNumber, today, now, hour }); }
  catch (e) { log(`context load failed: ${e.message}`); process.exit(0); }

  // Same prompt the agent gets, plus a strict single-shot output contract:
  // select a candidate FROM THE DIGEST (no live navigation) and return two lines.
  const prompt = buildQuotePrompt(ctx) +
    '\n───────────────────────────────────────────────────\n' +
    'OUTPUT MODE (overrides the browser-navigation steps above): You cannot browse. ' +
    'Select the single best candidate FROM THE FEED DIGEST above (use its text as given) ' +
    'that touches your belief axes and is a substantive claim you can engage — obeying ' +
    'every HARD SKIP, the SUBSTANCE/CITE-THE-CLAIM tests, the columnist structure, and the ' +
    'Tagalog rule. Do NOT write files, JSON, or call tools. Output EXACTLY two lines:\n' +
    'Line 1: the source tweet URL (copied verbatim from the digest)\n' +
    'Line 2: your quote commentary (max 240 chars, no surrounding quotes)\n' +
    'If no digest candidate qualifies, output exactly: SKIP';

  let raw;
  try { raw = await compose(prompt, { maxTokens: 500, tag: 'quote' }); }
  catch (e) { log(`compose failed: ${e.message}`); process.exit(0); }

  const lines = (raw || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines[0].toUpperCase() === 'SKIP') { log('compose returned SKIP/empty'); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }

  const url = lines[0];
  let commentary = lines.slice(1).join(' ').replace(/^["']|["']$/g, '').trim();
  if (!/^https?:\/\/(x\.com|twitter\.com)\//i.test(url) || !commentary) {
    log(`malformed output (url="${url.slice(0, 40)}", commentary len=${commentary.length}) — SKIP`);
    fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0);
  }

  // Shared gate: fact-check the commentary (voice_filter + critique run later in
  // postQuoteTweet). Corrects stale facts or rejects. maxLen is the platform
  // reality (~280 for the commentary tweet; the quoted post is a separate card)
  // even though the prompt targets ~240 for density.
  const gated = await passOutbound(commentary, { gates: ['factcheck'], maxLen: 280, tag: 'quote' });
  if (!gated.ok) { log(`gate rejected: ${gated.reason} — SKIP`); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }
  commentary = gated.text;

  fs.writeFileSync(DRAFT_PATH, `${url}\n${commentary}\n`);
  log(`wrote draft (${commentary.length} chars) quoting ${url}`);
  process.exit(0);
})();
