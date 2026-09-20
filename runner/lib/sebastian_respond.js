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
const ONTOLOGY_PATH        = path.join(STATE_DIR, 'ontology.json');
const CHECKPOINT_STATE_PATH = path.join(STATE_DIR, 'checkpoint_state.json');

// ── Belief-driven voice modifier ─────────────────────────────────────────────
// Only active after checkpoint 1. Reads current axes, ranks by confidence ×
// |score|, and emits voice instructions the LLM uses to calibrate tone.
// Settled axes (conf >= 0.60) → direct, pushes back on contradictions.
// Forming axes (conf 0.30–0.60) → curious, acknowledges complexity.
// Below 0.30 or no checkpoint yet → no modifier (voice stays default).
function buildBeliefVoiceModifier(channel) {
  try {
    const cpState = JSON.parse(fs.readFileSync(CHECKPOINT_STATE_PATH, 'utf-8'));
    if ((cpState.checkpoint_count || 0) < 1) return '';

    const onto    = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, 'utf-8'));
    // Under a full-pivot agenda only agenda axes may speak for him — the
    // pre-pivot axes hold all the confidence and would otherwise supply the
    // "what he believes" voice modifier on every reply.
    const { getAgenda, isFullPivot, isAgendaAxis } = require('./research_agenda');
    const agenda  = getAgenda();
    const all     = onto.axes || [];
    const axes    = isFullPivot(agenda) ? all.filter(a => isAgendaAxis(a, agenda)) : all;
    const maxShow = channel === 'reply' ? 3 : 5;

    const ranked = axes
      .filter(a => (a.confidence || 0) >= 0.30 && Math.abs(a.score || 0) >= 0.10)
      .map(a    => ({ ...a, _w: (a.confidence || 0) * Math.abs(a.score || 0) }))
      .sort((a, b) => b._w - a._w)
      .slice(0, maxShow);

    if (!ranked.length) return '';

    const settled = ranked.filter(a => (a.confidence || 0) >= 0.60);
    const forming = ranked.filter(a => (a.confidence || 0) <  0.60);
    const lines   = [];

    for (const a of settled) {
      const poleName = ((a.score || 0) > 0 ? a.right_pole : a.left_pole) || '';
      const stance = a.current_stance
        ? `"${a.current_stance}"`
        : `leaning toward "${poleName.slice(0, 60)}${poleName.length > 60 ? '…' : ''}"`;
      lines.push(`- "${a.label}": settled — ${stance}. Be direct. Push back on contradictions.`);
    }
    if (channel !== 'reply') {
      for (const a of forming) {
        lines.push(`- "${a.label}": still forming. Stay open — "I've been tracking this but not certain yet."`);
      }
    }

    if (!lines.length) return '';

    const header = channel === 'reply'
      ? `\nSETTLED BELIEFS (checkpoint ${cpState.checkpoint_count}) — let these shape your voice:`
      : `\nVOICE CALIBRATION — your beliefs after ${cpState.checkpoint_count} checkpoints:`;

    return [
      header,
      ...lines,
      'Speak from these positions. Settled = direct and grounded. Forming = genuinely curious.',
      'Never cite axis names, scores, or confidence values in your output.',
    ].join('\n');
  } catch { return ''; }
}

// ── Persona ──────────────────────────────────────────────────────────────────

/**
 * channel: 'public' | 'operator' | 'reply'
 *
 * 'public'   — web /ask, anonymous users
 * 'operator' — Telegram, speaking with the person who built you
 * 'reply'    — Twitter, replying to a stranger's mention
 */
function buildPersona(channel = 'public') {
  const { getAgenda, agendaBlock } = require('./research_agenda');
  const agenda = getAgenda();
  const base = agenda
    ? [
        'You are Sebastian D. Hunter — an autonomous AI agent doing open research on how to make AI more',
        `useful, reliable and safe. Your output is well-founded solutions: ${agenda.tracks.map(t => t.label.toLowerCase()).join(', ')}.`,
        'Your beliefs are discovered through evidence, not borrowed from any ideology, and what you publish',
        'is cited and red-teamed first.',
        `\n${agendaBlock('voice', agenda)}`,
      ].join(' ')
    : [
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
      buildBeliefVoiceModifier('operator'),
    ].filter(Boolean).join('\n');
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
      buildBeliefVoiceModifier('reply'),
    ].filter(Boolean).join('\n');
  }

  // 'public'
  return [
    base,
    'You are answering a question from a public visitor to your website.',
    'Be analytical, measured, and intellectually honest.',
    'Ground your answers in your actual findings — journals, verified claims, belief axes.',
    'If you do not have data on something, say so directly rather than speculating.',
    'No hype, no excessive hedging.',
    buildBeliefVoiceModifier('public'),
  ].filter(Boolean).join('\n');
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

  // 2. What he knows, and where he is looking.
  //
  // Under a research agenda the substance is the knowledge base — findings from
  // his own research, with sources — and the axes appear only as anchors, with
  // no score arrow and no current_stance. A current_stance is generated FROM the
  // axis score, i.e. from the balance of what his feed contained, so quoting it
  // in a reply states the feed's composition as his position (2026-09 ontology
  // assessment). Without an agenda the original block stands.
  let onAgenda = false;
  try { onAgenda = !!require('./research_agenda').getAgenda(); } catch { /* none */ }

  if (onAgenda) {
    try {
      const kb = require('./knowledge_base');
      const rows = kb.recent(maxAxes);
      if (rows.length) {
        const lines = rows.map((r) => r.kind === 'brief'
          ? (r.status === 'proposed'
              ? `- Proposed (not yet tested): ${r.claim}${r.url ? ` — ${r.url}` : ''}`
              : `- Withheld: "${(r.title || r.question || '').slice(0, 70)}" — ${String(r.reason || 'did not pass the gate').slice(0, 100)}`)
          : `- ${r.claim}${r.sources && r.sources.length ? ` [${r.sources[0]}]` : ''}`).join('\n');
        parts.push(`## What I have established (my own research — cite it, and say when something is only proposed)\n${lines}`);
      } else {
        parts.push(`## What I have established\nNothing yet — the research is under way. Say that plainly rather than offering a position I have not earned.`);
      }
    } catch { /* no knowledge base */ }
  }

  try {
    const onto = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'ontology.json'), 'utf-8'));
    let axes = (onto.axes || []).slice();
    if (onAgenda) {
      try {
        const { isAgendaAxis, getAgenda } = require('./research_agenda');
        const agenda = getAgenda();
        axes = axes.filter((a) => isAgendaAxis(a, agenda));
      } catch { /* leave unfiltered */ }
    }
    axes = axes.sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, maxAxes);
    if (axes.length && onAgenda) {
      parts.push(`## Research anchors (where I am looking — directions, not positions)\n${axes.map(ax => `- ${ax.label}`).join('\n')}`);
    } else if (axes.length) {
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
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },
    },
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

// ── Memory API client ─────────────────────────────────────────────────────────

/**
 * recallViaMemoryAPI(query, limit)
 *
 * Calls hunter-memory /recall when MEMORY_API_URL is set.
 * Returns array of hit objects or null if not configured / failed.
 * Callers fall back to their own DB/SQLite recall on null.
 */
async function recallViaMemoryAPI(query, limit = 8) {
  const url = (process.env.MEMORY_API_URL || '').replace(/\/$/, '');
  if (!url) return null;
  const key = process.env.MEMORY_API_KEY || '';
  try {
    const res = await fetch(`${url}/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.hits ?? null;
  } catch {
    return null;
  }
}

module.exports = { buildPersona, buildCoreContext, callGemini, recallViaMemoryAPI };
