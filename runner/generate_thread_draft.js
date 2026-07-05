#!/usr/bin/env node
'use strict';
/**
 * runner/generate_thread_draft.js — generate a 4-tweet discourse thread draft
 *
 * Weekly cadence (gated by post_thread.js checking thread_state.json).
 * Loads top axes + feed digest + vocation → calls Gemini → saves thread_draft.json.
 *
 * Run: node runner/generate_thread_draft.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = require('./lib/config');
const { callVertex } = require('./vertex.js');

const THREAD_DRAFT_PATH = path.join(config.STATE_DIR, 'thread_draft.json');
const THREAD_STATE_PATH = path.join(config.STATE_DIR, 'thread_state.json');

// ── Context helpers ───────────────────────────────────────────────────────────

function readSafe(fp, fallback = '') {
  try { return fs.readFileSync(fp, 'utf-8').replace(/`/g, "'") || fallback; }
  catch { return fallback; }
}

function readTail(fp, lines, fallback = '') {
  try {
    const content = fs.readFileSync(fp, 'utf-8');
    return content.split('\n').slice(-lines).join('\n') || fallback;
  } catch { return fallback; }
}

function formatTopAxes() {
  try {
    const o = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf-8'));
    const raw = Array.isArray(o.axes) ? o.axes : Object.values(o.axes || {});
    return raw
      .filter(a => (a.confidence || 0) >= 0.65 && Math.abs(a.score || 0) >= 0.1)
      .sort((a, b) => (b.confidence * Math.abs(b.score)) - (a.confidence * Math.abs(a.score)))
      .slice(0, 4)
      .map(a => {
        const ev = (a.evidence_log || []).slice(-2).map(e => '    * ' + e.content.slice(0, 120)).join('\n');
        return `- ${a.label} (conf: ${(a.confidence * 100).toFixed(0)}%)\n  LEFT: ${a.left_pole}\n  RIGHT: ${a.right_pole}${ev ? '\n  Recent evidence:\n' + ev : ''}`;
      }).join('\n\n') || '(unavailable)';
  } catch { return '(unavailable)'; }
}

function formatVocation() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(config.STATE_DIR, 'vocation.json'), 'utf-8'));
    const parts = [];
    if (v.label)     parts.push(`Label: ${v.label}`);
    if (v.direction) parts.push(`Direction: ${v.direction}`);
    if (v.intent)    parts.push(`Intent: ${v.intent}`);
    return parts.join('\n') || '(forming)';
  } catch { return '(forming)'; }
}

function recentPostTexts() {
  try {
    const data = JSON.parse(fs.readFileSync(config.POSTS_LOG_PATH, 'utf-8'));
    const posts = Array.isArray(data) ? data : (data.posts || []);
    return posts
      .filter(p => p.type === 'tweet' || p.type === 'claims_thread')
      .slice(-5)
      .map(p => '- ' + (p.content || p.text || '').slice(0, 120))
      .join('\n') || '(none)';
  } catch { return '(none)'; }
}

function todayArticleExcerpt() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const dir = path.join(ROOT, 'articles');
    const files = fs.readdirSync(dir).filter(f => f.startsWith(today) && f.endsWith('.md')).sort();
    if (!files.length) return '(no article today yet)';
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    const body = content.replace(/^---[\s\S]*?---\s*/, '');
    const paras = body.split('\n\n').filter(p => p.trim().length > 30 && !p.startsWith('#'));
    return (paras.slice(0, 2).join('\n\n') || body.slice(0, 600)).slice(0, 600);
  } catch { return '(none yet)'; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const today = new Date().toISOString().slice(0, 10);

  // Check 7-day gate
  try {
    const state = JSON.parse(fs.readFileSync(THREAD_STATE_PATH, 'utf-8'));
    if (state.last_posted) {
      const elapsed = Date.now() - new Date(state.last_posted).getTime();
      const days = elapsed / 86400000;
      if (days < 7) {
        console.log(`[thread_draft] last thread posted ${days.toFixed(1)}d ago — skipping (7d cooldown)`);
        process.exit(0);
      }
    }
  } catch {} // no state yet = proceed

  console.log('[thread_draft] building context...');
  const ctx = {
    today,
    vocation:      formatVocation(),
    topAxes:       formatTopAxes(),
    feedDigest:    readTail(config.FEED_DIGEST_PATH, 200, '(no digest)'),
    articleExcerpt: todayArticleExcerpt(),
    recentPosts:   recentPostTexts(),
  };

  const buildThreadPrompt = require('./lib/prompts/thread');
  const prompt = buildThreadPrompt(ctx);

  console.log('[thread_draft] calling LLM...');
  let raw;
  try {
    raw = await callVertex(prompt, 4096, { thinkingBudget: 2048 });
  } catch (e) {
    console.error('[thread_draft] LLM call failed:', e.message);
    process.exit(1);
  }

  if (!raw || raw.length < 100) {
    console.error('[thread_draft] response too short — aborting');
    process.exit(1);
  }

  // Parse JSON — strip markdown fences if present
  let draft;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    draft = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[thread_draft] could not parse JSON from response');
      console.error('[thread_draft] raw:', raw.slice(0, 500));
      process.exit(1);
    }
    try { draft = JSON.parse(match[0]); }
    catch (e2) {
      console.error('[thread_draft] JSON parse failed:', e2.message);
      process.exit(1);
    }
  }

  // Validate required fields
  for (const field of ['tweet1', 'tweet2', 'tweet3', 'tweet4']) {
    if (!draft[field] || typeof draft[field] !== 'string' || draft[field].length < 10) {
      console.error(`[thread_draft] missing or empty field: ${field}`);
      process.exit(1);
    }
    if (draft[field].length > 280) {
      console.warn(`[thread_draft] ${field} is ${draft[field].length} chars — over 280, will truncate`);
      draft[field] = draft[field].slice(0, 277) + '…';
    }
  }

  draft.generated_at = new Date().toISOString();
  draft.today = today;

  fs.writeFileSync(THREAD_DRAFT_PATH, JSON.stringify(draft, null, 2));
  console.log(`[thread_draft] saved → state/thread_draft.json`);
  console.log(`[thread_draft] topic: ${draft.topic || '(none)'}`);
  for (const k of ['tweet1', 'tweet2', 'tweet3', 'tweet4']) {
    console.log(`[thread_draft] ${k} (${draft[k].length}c): ${draft[k].slice(0, 80)}…`);
  }
})();
