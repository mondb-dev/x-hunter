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

// Body budget. The journal URL is appended after the gate: 240 + newline + a
// 23-char t.co link = 264, inside X's 280 with room to spare.
const MAX_LEN = 240;
// Below this a trimmed tweet has lost its point — better to skip than to post
// a fragment.
const MIN_USABLE_LEN = 100;

/**
 * trimToLength(text, max) → string|null
 * Shorten on a natural boundary: prefer ending at the last complete sentence
 * inside the budget, else cut at the last whole word and add an ellipsis.
 * Returns null when the result would be too short to be worth posting.
 */
function trimToLength(text, max) {
  if (text.length <= max) return text;
  const sentenceEnd = text.slice(0, max).search(/[^.!?]*$/);
  if (sentenceEnd > MIN_USABLE_LEN) {
    const upToSentence = text.slice(0, sentenceEnd).trim();
    if (upToSentence.length >= MIN_USABLE_LEN) return upToSentence;
  }
  const cut = text.slice(0, max - 1).replace(/\s+\S*$/, '').trim();
  if (cut.length < MIN_USABLE_LEN) return null;
  return `${cut}…`;
}

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

  const firstLine = t => (t || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  let clean = firstLine(raw).replace(/^["']|["']$/g, '').trim();
  // Write an explicit SKIP (mirrors the agent's contract; postRegularTweet skips
  // on draft==='SKIP') so a deliberate no-tweet is a decision, not a missing file.
  if (!clean || clean.toUpperCase() === 'SKIP') { log('compose returned SKIP/empty'); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }

  // ── Over-length recovery ────────────────────────────────────────────────────
  // MAX_LEN is 240, not 280, because the journal URL is appended after this gate
  // (240 + newline + 23-char t.co = 264, inside X's 280 with headroom).
  //
  // This used to be a hard SKIP, which threw away the whole posting cycle on a
  // single instruction-following miss — the prompt asks for 230 and Claude came
  // back with 277 on cycle 4668, costing a tweet slot for 30 minutes. Note the
  // downstream gates CANNOT save an over-length draft: passOutbound's maxLen only
  // constrains a factcheck *correction*, and voice_filter's hard limit is 280, so
  // a 277-char draft passes both and only fails at X once the URL is appended.
  // Hence: retry once with the miss quantified, then trim on a boundary.
  if (clean.length > MAX_LEN) {
    log(`compose too long (${clean.length} chars) — one corrective retry`);
    try {
      const retryPrompt =
        `${prompt}\n\nYour previous draft was ${clean.length} characters, ` +
        `${clean.length - MAX_LEN} over the limit. Rewrite it under ${MAX_LEN - 10} ` +
        `characters. Keep the specific actor, claim, number and any @handle — cut ` +
        `adjectives, qualifiers and throat-clearing, never the evidence.`;
      const retry = firstLine(await compose(retryPrompt, { maxTokens: 400, tag: 'tweet-retry' }))
        .replace(/^["']|["']$/g, '').trim();
      if (retry && retry.toUpperCase() !== 'SKIP' && retry.length < clean.length) {
        log(`retry produced ${retry.length} chars`);
        clean = retry;
      }
    } catch (e) { log(`retry failed (${e.message}) — falling through to trim`); }
  }

  if (clean.length > MAX_LEN) {
    const trimmed = trimToLength(clean, MAX_LEN);
    if (trimmed) { log(`trimmed ${clean.length} → ${trimmed.length} chars`); clean = trimmed; }
    else { log(`still ${clean.length} chars and untrimmable — SKIP`); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }
  }

  // Shared fact-check gate (voice_filter + critique_tweet run downstream in post.js).
  const gated = await passOutbound(clean, { gates: ['factcheck'], maxLen: 240, tag: 'tweet' });
  if (!gated.ok) { log(`gate rejected: ${gated.reason} — SKIP`); fs.writeFileSync(DRAFT_PATH, 'SKIP\n'); process.exit(0); }
  const finalText = gated.text;

  const journalUrl = `https://sebastianhunter.fun/journal/${today}/${hour}`;
  fs.writeFileSync(DRAFT_PATH, `${finalText}\n${journalUrl}\n`);
  log(`wrote draft (${finalText.length} chars): ${finalText.slice(0, 60)}...`);

  // Image auto-trigger: pick the lead source-with-image from the same browse
  // notes this tweet was composed from, and set tweet_image_source.txt so the
  // poster (post_x_helmstack) copies that og:image + attributes it. A miss
  // leaves no file → text-only post, unchanged. Best-effort: never block the
  // draft on image selection. IMAGE_AUTO_TRIGGER=0 disables it.
  const imgSrcPath = path.join(path.dirname(DRAFT_PATH), 'tweet_image_source.txt');
  try { fs.unlinkSync(imgSrcPath); } catch { /* none pending */ }
  if (process.env.IMAGE_AUTO_TRIGGER !== '0') {
    try {
      const { pickLeadSource } = require('./lib/lead_source_image');
      const notes = ctx.browseNotesFull || '';
      const lead = await pickLeadSource(finalText, notes);
      if (lead) {
        fs.writeFileSync(imgSrcPath, lead.url + '\n');
        log(`image source set: ${lead.source} (${lead.url})`);
      }
    } catch (e) { log(`image auto-trigger skipped: ${e.message}`); }
  }
  process.exit(0);
})();
