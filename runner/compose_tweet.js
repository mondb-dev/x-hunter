#!/usr/bin/env node
'use strict';
/**
 * runner/compose_tweet.js — compose a single original tweet draft directly,
 * without the agentic gemini_agent tool-loop.
 *
 * WHY: the TWEET cycle's `agentRun({ agent: 'x-hunter-tweet' })` asks the local
 * qwen model to compose AND write state/tweet_draft.txt via a tool. The small
 * model routinely completes without emitting the file → the orchestrator logs
 * `no_draft` and nothing posts. The tweet prompt is already FILE-ONLY (all
 * context pre-loaded, no browsing), so composition is a single-shot job — the
 * exact shape the LinkedIn/thread drafts already use. This script builds the
 * SAME prompt (loadContext + buildTweetPrompt) and composes it through
 * runner/lib/compose.js (Claude terminal when COMPOSE_BACKEND=claude, else the
 * local/Vertex brain), then writes state/tweet_draft.txt in the expected format.
 *
 * SAFE FALLBACK: if a non-empty, non-SKIP draft already exists, this exits
 * without overwriting — so it never clobbers a draft the agent did produce.
 *
 * Run: node runner/compose_tweet.js   (honors CYCLE/DAY_NUMBER/TODAY/NOW/HOUR env)
 */

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const config = require('./lib/config');

// Load .env for standalone runs (when invoked by the orchestrator the env is
// already inherited; this is a no-op fill-in for missing keys).
if (fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const loadContext     = require('./lib/prompts/context');
const buildTweetPrompt = require('./lib/prompts/tweet');
const { compose }     = require('./lib/compose');
const { passOutbound } = require('./lib/outbound_gates');

const DRAFT_PATH = config.TWEET_DRAFT_PATH || path.join(config.STATE_DIR, 'tweet_draft.txt');
const log = (m) => console.log(`[compose_tweet] ${m}`);

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

  // Match the orchestrator/browse-notes clock: today is UTC-dated, but now/hour
  // are LOCAL (toTimeString/getHours) — the browse notes are stamped in local
  // time, so feeding UTC here makes the model think the notes are stale/future.
  const nowDate = new Date();
  const today = process.env.TODAY || nowDate.toISOString().slice(0, 10);
  const hour  = process.env.HOUR  || String(nowDate.getHours()).padStart(2, '0');
  const now   = process.env.NOW   || nowDate.toTimeString().slice(0, 5);
  const cycle = parseInt(process.env.CYCLE_NUMBER || process.env.CYCLE || '', 10) || currentCycle();
  const dayNumber = parseInt(process.env.DAY_NUMBER || '', 10) || dayNumberFrom(today);

  let ctx;
  try {
    ctx = loadContext({ type: 'tweet', cycle, dayNumber, today, now, hour });
  } catch (e) { log(`context load failed: ${e.message}`); process.exit(0); }

  // Same prompt the agent gets, plus a strict single-shot output contract:
  // no tools, no files, no JSON — just the tweet body (or SKIP).
  const prompt = buildTweetPrompt(ctx) +
    '\n───────────────────────────────────────────────────\n' +
    'OUTPUT MODE (overrides the file-writing steps AND the "fresh THIS cycle" gate 4d above):\n' +
    'You are composing ONE tweet from the ACCUMULATED browse notes, discourse, and belief axes\n' +
    'shown above — you do NOT need brand-new material from this exact cycle; recurring or ongoing\n' +
    'stories are valid. Pick the single strongest, most specific story or tension in the notes and\n' +
    'write it as a sharp, grounded tweet that names a specific actor / claim / number / event (tag\n' +
    'the @handle when the notes provide one). Honor every voice / specificity / lede / language\n' +
    'rule above (Taglish for Philippine topics). Do NOT write files, emit JSON, or call tools.\n' +
    'Output ONLY the final tweet body as a SINGLE line (max 230 characters) — no journal URL, no\n' +
    'surrounding quotes, no label. Output exactly SKIP only if the notes contain NO specific,\n' +
    'nameable material at all (empty/unavailable feed).';

  let raw;
  try {
    raw = await compose(prompt, { maxTokens: 400, tag: 'tweet' });
  } catch (e) { log(`compose failed: ${e.message}`); process.exit(0); }

  const line1 = (raw || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  const clean = line1.replace(/^["']|["']$/g, '').trim();
  // Write an explicit SKIP (mirrors the agent's contract; postRegularTweet skips
  // on draft==='SKIP') so a deliberate no-tweet is a decision, not a missing file.
  if (!clean || clean.toUpperCase() === 'SKIP') { log('compose returned SKIP/empty'); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }
  if (clean.length > 240) { log(`compose too long (${clean.length} chars) — SKIP`); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }

  // Shared fact-check gate (voice_filter + critique_tweet run downstream in post.js).
  const gated = await passOutbound(clean, { gates: ['factcheck'], maxLen: 240, tag: 'tweet' });
  if (!gated.ok) { log(`gate rejected: ${gated.reason} — SKIP`); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }
  const finalText = gated.text;

  const journalUrl = `https://sebastianhunter.fun/journal/${today}/${hour}`;
  fs.writeFileSync(DRAFT_PATH, `${finalText}\n${journalUrl}\n`);
  log(`wrote draft (${finalText.length} chars): ${finalText.slice(0, 60)}...`);
  process.exit(0);
})();
