#!/usr/bin/env node
/**
 * runner/posts_assessment.js — daily posting self-review
 *
 * Sebastian reviews his own posts to improve. This is NOT a metrics dashboard —
 * it's a mirror. The assessment asks: were today's posts aligned with my goals,
 * reflective of what I actually know, varied, and worth reading?
 *
 * Two outputs:
 *   1. daily/posts_assessment_YYYY-MM-DD.md  — full critique (archive)
 *   2. state/posting_directive.txt           — 3 concrete rules for tomorrow
 *      (injected into tweet + quote prompts so Sebastian reads it before posting)
 *
 * Reads:  state/posts_log.json, state/ontology.json, state/capture_state.json,
 *         state/vocation.json
 * Writes: daily/posts_assessment_YYYY-MM-DD.md, state/posting_directive.txt
 *
 * Called once per day from daily.js reports().
 * Non-fatal: exits 0 on any error.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { generate } = require('./llm');

const ROOT          = path.resolve(__dirname, '..');
const DAILY_DIR     = path.join(ROOT, 'daily');
const POSTS_LOG     = path.join(ROOT, 'state', 'posts_log.json');
const ONTO_PATH     = path.join(ROOT, 'state', 'ontology.json');
const CAPTURE_PATH  = path.join(ROOT, 'state', 'capture_state.json');
const VOCATION_PATH = path.join(ROOT, 'state', 'vocation.json');
const DIRECTIVE_OUT = path.join(ROOT, 'state', 'posting_directive.txt');

const today = new Date().toISOString().slice(0, 10);

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

(async function main() {
  try {
    const posts    = loadJson(POSTS_LOG);
    const onto     = loadJson(ONTO_PATH);
    const capture  = loadJson(CAPTURE_PATH);
    const vocation = loadJson(VOCATION_PATH);

    if (!posts?.posts?.length) {
      console.log('[posts_assessment] no posts found — skipping');
      return;
    }

    // ── Collect today's posts ───────────────────────────────────────────

    const todayPosts = posts.posts.filter(p => {
      const d = p.date || (p.posted_at ? p.posted_at.slice(0, 10) : '');
      return d === today;
    });

    if (todayPosts.length === 0) {
      console.log('[posts_assessment] no posts today — skipping');
      return;
    }

    // Last 5 days for repetition/pattern detection
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const recentPosts = posts.posts.filter(p => {
      const d = p.date || (p.posted_at ? p.posted_at.slice(0, 10) : '');
      return d >= fiveDaysAgo && d < today;
    });

    // ── Format data for LLM ─────────────────────────────────────────────

    const formatPost = (p, i) => {
      const text = p.content || p.text || '(empty)';
      const type = p.type || 'unknown';
      const time = p.posted_at ? p.posted_at.slice(11, 16) : '??:??';
      const src  = p.source_url ? `\n   Quoting: ${p.source_url}` : '';
      return `${i + 1}. [${type}] (${time} UTC)${src}\n   "${text}"`;
    };

    const todayFormatted  = todayPosts.map(formatPost).join('\n\n');
    const recentFormatted = recentPosts.length > 0
      ? recentPosts.slice(-15).map(formatPost).join('\n\n')
      : '(no posts in the previous 5 days)';

    // Top axes — what Sebastian actually believes
    const axes = (onto?.axes || [])
      .filter(a => (a.confidence || 0) > 0)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 8);

    const axesFormatted = axes.length > 0
      ? axes.map(a =>
          `- ${a.label} (conf:${((a.confidence || 0) * 100).toFixed(0)}%, ` +
          `score:${(a.score || 0).toFixed(2)}, ev:${(a.evidence_log || []).length})`
        ).join('\n')
      : '(none available)';

    // Vocation — what Sebastian is trying to become
    const vocationNote = vocation?.description || '(not yet defined)';

    // Capture — is evidence lopsided?
    const captureNote = capture?.summary || '(not yet run)';

    // ── LLM Assessment ──────────────────────────────────────────────────

    const prompt = `You are Sebastian D. Hunter's posting coach. Your job is to help him get better at
tweeting — not by gaming engagement, but by making his posts genuinely worth reading.

Sebastian is an autonomous agent on X. He is building a worldview from scratch by observing
discourse. His vocation: "${vocationNote}". He posts to think out loud, test his beliefs
in public, and engage honestly. He is NOT optimizing for likes.

## What makes a good Sebastian post
- GOAL-ALIGNED: Connects to his vocation and active belief axes. Random observations
  about unrelated topics dilute his voice. Every post should advance his understanding
  or express a position that matters to what he's becoming.
- NOT REPETITIVE: Each post should say something new. Repeating the same theme with
  slightly different words across days is a failure. Check: could this post be mistaken
  for one he wrote yesterday? If yes, it's redundant.
- REFLECTIVE OF KNOWLEDGE: Posts should show that Sebastian has read, tracked, and
  absorbed evidence — not just react to headlines. Reference specific things he observed.
  The reader should think "this person has been paying attention."
- REFLECTIVE OF CONVICTION: High-confidence beliefs deserve direct, clear expression.
  Low-confidence topics deserve genuine questions. The reader should be able to feel
  how sure Sebastian is without him saying a number.
- ENGAGING: Not engagement-bait, but genuinely interesting to read. A good post makes
  someone think, not just agree. It names a specific tension, asks a question nobody
  else is asking, or frames something familiar in a surprising way.

## Sebastian's strongest belief axes
${axesFormatted}

## Capture detection
${captureNote}

## Today's posts (${today}) — THE POSTS BEING ASSESSED
${todayFormatted}

## Recent posts (previous 5 days) — FOR REPETITION CHECK
${recentFormatted}

## Your task

Write TWO sections:

### SECTION 1: ASSESSMENT (for the daily archive)

Review today's posts against the five criteria above. For each post, be specific:
- What worked? (name the exact phrase or insight that was effective)
- What failed? (name the exact problem — vagueness, repetition, misaligned conviction, etc.)
- Was it goal-aligned? (connects to vocation/axes, or was it off-topic noise?)

Then identify:
- **Repetition patterns**: Compare today vs. recent posts. Quote specific phrases or themes
  that have been recycled. If Sebastian said "demands scrutiny" twice this week, call it out.
- **Conviction mismatches**: Any post where the confidence of the voice doesn't match the
  underlying axis confidence? (Bold claim on a low-confidence axis? Timid on a high-confidence one?)
- **Best post today**: Which one and why — what made it genuinely worth reading?
- **Worst post today**: Which one and why — what made it forgettable, repetitive, or hollow?

### SECTION 2: POSTING DIRECTIVE (injected into tomorrow's prompts)

Write EXACTLY 3 rules for tomorrow's posting. These must be:
- Brutally specific (not "be more concrete" — instead "stop using the phrase 'demands scrutiny'")
- Actionable (something Sebastian can check before hitting send)
- Different from generic advice (tailored to the actual problems you found today)

Format the directive as:
POSTING DIRECTIVE (from yesterday's review):
1. [specific rule]
2. [specific rule]
3. [specific rule]

Keep SECTION 1 under 500 words. Keep SECTION 2 under 100 words.
Separate sections with --- on its own line.`;

    const assessment = await generate(prompt, {
      temperature: 0.4,
      maxTokens: 1500,
      timeoutMs: 45_000,
    });

    if (!assessment || assessment.length < 80) {
      console.log('[posts_assessment] LLM returned insufficient output — skipping');
      return;
    }

    // ── Parse directive from assessment ─────────────────────────────────

    // Split on --- to extract SECTION 2
    const sections = assessment.split(/\n---\n/);
    const assessmentBody = sections[0] || assessment;
    const directiveRaw   = sections[1] || '';

    // Extract the directive lines (look for "POSTING DIRECTIVE" header or numbered lines)
    let directive = '';
    if (directiveRaw.trim()) {
      directive = directiveRaw.trim();
    } else {
      // Fallback: try to find directive in the full text
      const m = assessment.match(/POSTING DIRECTIVE[\s\S]*?(1\.[\s\S]*?3\.[^\n]+)/i);
      if (m) directive = 'POSTING DIRECTIVE (from yesterday\'s review):\n' + m[1].trim();
    }

    // ── Write posting directive for tomorrow's prompts ──────────────────

    if (directive) {
      fs.writeFileSync(DIRECTIVE_OUT, directive, 'utf-8');
      console.log(`[posts_assessment] directive written to state/posting_directive.txt`);
    }

    // ── Write full report ───────────────────────────────────────────────

    if (!fs.existsSync(DAILY_DIR)) fs.mkdirSync(DAILY_DIR, { recursive: true });
    const outPath = path.join(DAILY_DIR, `posts_assessment_${today}.md`);

    const types = [...new Set(todayPosts.map(p => p.type || 'unknown'))];
    const tweetCount = todayPosts.filter(p => p.type === 'tweet').length;
    const quoteCount = todayPosts.filter(p => p.type === 'quote').length;

    const report = `---
date: "${today}"
title: "Posts Assessment — ${today}"
posts_count: ${todayPosts.length}
types: ${JSON.stringify(types)}
---

# Posts Assessment — ${today}

**Generated:** ${new Date().toISOString()}
**Posts today:** ${todayPosts.length} (${tweetCount} tweets, ${quoteCount} quotes)
**Vocation:** ${vocationNote}
**Capture status:** ${capture?.status || 'unknown'}

---

## Today's posts

${todayFormatted}

---

## Assessment

${assessmentBody}

---

## Posting directive for tomorrow

${directive || '(could not extract directive)'}

---

*Generated by posts_assessment.js*
`;

    fs.writeFileSync(outPath, report, 'utf-8');
    console.log(`[posts_assessment] written: daily/posts_assessment_${today}.md (${todayPosts.length} posts)`);

  } catch (err) {
    console.error(`[posts_assessment] failed: ${err.message}`);
    process.exit(0); // non-fatal
  }
})();
