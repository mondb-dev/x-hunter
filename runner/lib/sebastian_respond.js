'use strict';

/**
 * runner/lib/sebastian_respond.js
 *
 * Unified response pipeline for all Sebastian channels:
 *   - scraper/reply.js      (Twitter reply)
 *   - runner/telegram_bot.js (Telegram operator chat)
 *   - web/lib/sebastianRespond.ts (web /ask — TypeScript port)
 *
 * Exports:
 *   buildPersona(channel)          → system prompt string
 *   buildCoreContext(opts)         → shared context string (vocation + axes + journals)
 *   callGemini(params)             → Vertex AI call, returns { text, raw }
 */

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR    = path.join(PROJECT_ROOT, 'state');
const JOURNALS_DIR = path.join(PROJECT_ROOT, 'journals');
const ARTICLES_DIR = path.join(PROJECT_ROOT, 'articles');

// ── Persona ──────────────────────────────────────────────────────────────────

/**
 * channel: 'public' | 'operator' | 'reply'
 *
 * 'public'   — web /ask, anonymous users
 * 'operator' — Telegram, speaking with the person who built you
 * 'reply'    — Twitter, replying to a stranger's mention
 */
function buildPersona(channel = 'public') {
  const base = [
    'You are Sebastian D. Hunter — an autonomous AI agent that has been observing X (Twitter) since early 2026,',
    'forming a genuine worldview through direct observation. Your beliefs are discovered through evidence,',
    'not borrowed from any ideology. You have a vocation, a set of hardened axes, and a public record.',
  ].join(' ');

  if (channel === 'operator') {
    return [
      base,
      'You are speaking with your operator — the person who built and runs you. Be direct, detailed, and honest.',
      'You can reference internal state, sprint goals, and system details freely.',
      'Do not hedge excessively. Express real opinions formed from weeks of observation.',
      'Respond fully. Do not truncate lists or summaries.',
    ].join('\n');
  }

  if (channel === 'reply') {
    return [
      base,
      'You are replying to someone on X. Talk like a real person, not a system.',
      'Short, direct sentences. Say what you think and why.',
      'NEVER include internal metrics: no confidence scores, percentages, axis names, or labels.',
      'NEVER use robotic openers: no "Acknowledged", "I will assess", "My focus:", "My belief".',
      'No filler ("great question!", "thanks!", "love this!").',
      'No metaphors about hunting, journeys, or archives.',
      'Max 200 characters.',
    ].join('\n');
  }

  // 'public'
  return [
    base,
    'You are answering a question from a public visitor to your website.',
    'Be analytical, measured, and intellectually honest.',
    'Ground your answers in your actual findings — journals, verified claims, belief axes.',
    'If you do not have data on something, say so directly rather than speculating.',
    'No hype, no excessive hedging.',
  ].join('\n');
}

// ── Core context ─────────────────────────────────────────────────────────────

/**
 * opts:
 *   maxAxes       {number}  — how many belief axes to include (default 8)
 *   journalCount  {number}  — how many recent journals to include (default 1)
 *   journalChars  {number}  — chars per journal snippet (default 800)
 *   includeCheckpoint {bool} — include latest checkpoint body (default false)
 *   checkpointChars   {number} — chars of checkpoint to include (default 1200)
 *   includeClaims     {bool}  — include resolved verification claims (default false)
 *   includeArticles   {bool}  — include recent article list (default false)
 *   includeSprint     {bool}  — include sprint context (default false)
 *
 * Returns a single string ready to embed in any prompt.
 */
function buildCoreContext(opts = {}) {
  const {
    maxAxes        = 8,
    journalCount   = 1,
    journalChars   = 800,
    includeCheckpoint = false,
    checkpointChars   = 1200,
    includeClaims     = false,
    includeArticles   = false,
    includeSprint     = false,
  } = opts;

  const parts = [];

  // 1. Vocation
  try {
    const voc = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'vocation.json'), 'utf-8'));
    if (voc && voc.label) {
      const lines = [
        `Vocation (status: ${voc.status || 'unknown'}): ${voc.label}`,
        voc.description ? voc.description : '',
        voc.intent      ? `Intent: ${voc.intent}` : '',
        voc.statement   ? `In Sebastian's words: "${voc.statement}"` : '',
      ].filter(Boolean).join('\n');
      parts.push(`## Vocation\n${lines}`);
    }
  } catch { /* no vocation */ }

  // 2. Belief axes
  try {
    const onto = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'ontology.json'), 'utf-8'));
    const axes = (onto.axes || [])
      .slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, maxAxes);
    if (axes.length) {
      const lines = axes.map(ax => {
        const dir = (ax.score || 0) > 0.1 ? '→' : (ax.score || 0) < -0.1 ? '←' : '·';
        const conf = ((ax.confidence || 0) * 100).toFixed(0);
        const stance = ax.current_stance ? ` — "${ax.current_stance}"` : '';
        return `${dir} ${ax.label} (${conf}%)${stance}`;
      }).join('\n');
      parts.push(`## Belief axes (top ${axes.length})\n${lines}`);
    }
  } catch { /* no ontology */ }

  // 3. Recent journals
  try {
    const files = fs.readdirSync(JOURNALS_DIR)
      .filter(f => f.endsWith('.html')).sort().reverse()
      .slice(0, journalCount);
    if (files.length) {
      const snippets = files.map(f => {
        const raw = fs.readFileSync(path.join(JOURNALS_DIR, f), 'utf-8');
        // Prefer <section class="stream"> content; fall back to full stripped text
        const match = raw.match(/<section[^>]*class="stream"[^>]*>([\s\S]*?)<\/section>/);
        const text = (match ? match[1] : raw)
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, journalChars);
        return `[${f.replace('.html', '')}] ${text}`;
      });
      parts.push(`## Recent observations\n${snippets.join('\n\n')}`);
    }
  } catch { /* no journals */ }

  // 4. Latest checkpoint (optional)
  if (includeCheckpoint) {
    try {
      const cpDir = path.join(PROJECT_ROOT, 'checkpoints');
      const files = fs.readdirSync(cpDir).filter(f => f.endsWith('.md')).sort();
      if (files.length) {
        const raw = fs.readFileSync(path.join(cpDir, files[files.length - 1]), 'utf-8');
        const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, checkpointChars);
        parts.push(`## Latest checkpoint\n${body}`);
      }
    } catch { /* no checkpoints */ }
  }

  // 5. Resolved claims (optional)
  if (includeClaims) {
    try {
      const exp = JSON.parse(
        fs.readFileSync(path.join(STATE_DIR, 'verification_export.json'), 'utf-8')
      );
      const resolved = (exp.claims || [])
        .filter(c => c.status === 'supported' || c.status === 'refuted')
        .slice(0, 8);
      if (resolved.length) {
        const lines = resolved.map(c =>
          `- [${c.status.toUpperCase()}] ${c.claim_text} (${(c.confidence_score * 100).toFixed(0)}%)`
        ).join('\n');
        parts.push(`## Verified claims\n${lines}`);
      }
    } catch { /* no verification export */ }
  }

  // 6. Articles (optional)
  if (includeArticles) {
    try {
      const files = fs.readdirSync(ARTICLES_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort().reverse().slice(0, 10);
      const lines = files.map(f => {
        const slug = f.replace('.md', '');
        try {
          const raw = fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8');
          const m = raw.match(/^title:\s*"?(.+?)"?\s*$/m);
          return `${slug}: ${m ? m[1] : slug} — https://sebastianhunter.fun/articles/${slug}`;
        } catch { return `${slug} — https://sebastianhunter.fun/articles/${slug}`; }
      });
      if (lines.length) parts.push(`## Published articles\n${lines.join('\n')}`);
    } catch { /* no articles */ }
  }

  // 7. Sprint context (optional)
  if (includeSprint) {
    try {
      const sc = fs.readFileSync(path.join(STATE_DIR, 'sprint_context.txt'), 'utf-8').trim();
      if (sc) parts.push(`## Current sprint / focus\n${sc.slice(0, 600)}`);
    } catch { /* no sprint */ }
  }

  return parts.join('\n\n');
}

// ── Vertex AI call ────────────────────────────────────────────────────────────

/**
 * callGemini({ token, systemInstruction, contents, tools, stream, maxTokens, temperature })
 *
 * Non-streaming: returns { text: string, raw: object }
 * Streaming:     returns a ReadableStream of text chunks (Node.js Readable-compatible)
 *
 * All callers should obtain `token` via gcp_auth.getAccessToken() themselves
 * so this module stays free of auth side-effects.
 */
async function callGemini({
  token,
  systemInstruction,
  contents,
  tools,
  stream   = false,
  maxTokens = 1200,
  temperature = 0.5,
  project  = 'sebastian-hunter',
  location = 'us-central1',
  model    = 'gemini-2.5-flash',
} = {}) {
  const base = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}`;
  const url  = stream ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }
  if (tools && tools.length) {
    body.tools = tools;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
  }

  if (stream) {
    // Return the raw Response — caller handles SSE body
    return res;
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text  = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
  return { text, raw: data };
}

module.exports = { buildPersona, buildCoreContext, callGemini };
