#!/usr/bin/env node
/**
 * runner/lib/compose.js — the "Claude terminal" composition-inference backend.
 *
 * Sebastian's non-agent brain runs on a small local model (qwen2.5-agent, ~7B —
 * see the LLM-backend notes), which is fine for scoring/gating but produces weak
 * *outbound* prose. This module lets the outputs that the world actually sees —
 * X replies/posts/quotes, LinkedIn posts/comments, and long-form articles — be
 * composed by the Claude Code CLI (`claude -p`) instead, while everything else
 * (relevance scoring, coherence critique, fact-check gates, planning) stays on
 * the cheap local model.
 *
 * WHY the CLI and not an API SDK: the user drives Claude through the terminal
 * (their existing auth lives in ~/.claude), there's no extra key to manage, and
 * `claude -p` is a stable, non-interactive text endpoint. We invoke it in a
 * stripped-down mode — full system-prompt override + no tools + no MCP — so it
 * behaves as a pure, cheap text generator (~$0.001/call, ~3-4s) rather than a
 * full agent (~$0.11/call from the ~18k-token agent system prompt).
 *
 *   compose(prompt, opts)   → Promise<string>   routed text (Claude or fallback)
 *   claudeCompose(prompt,o) → Promise<string>   Claude CLI only (throws on error)
 *   useClaudeCompose()      → boolean           is the Claude backend enabled?
 *
 * ENABLE: set COMPOSE_BACKEND=claude (or CLAUDE_COMPOSE=1) in hunter's .env.
 *   Default is OFF — with the flag unset, compose() is byte-for-byte the old
 *   callVertex() path, so wiring it in changes nothing until the switch is set.
 *
 * TUNE (.env, all optional):
 *   CLAUDE_COMPOSE_MODEL       Claude alias/id (default: sonnet). opts.claudeModel wins.
 *   CLAUDE_COMPOSE_TIMEOUT_MS  per-call kill timeout (default: 120000).
 *   CLAUDE_BIN                 path to the claude binary (default: "claude" on PATH).
 *
 * No external deps — Node built-ins only.
 */

'use strict';

const { spawn } = require('child_process');
const os = require('os');

// Replaces Claude Code's default agent system prompt entirely: no skills, no
// memory, no tool docs. Keeps the call cheap and the output clean. The caller's
// persona/voice lives in the user prompt, exactly as it did for callVertex.
const DEFAULT_SYSTEM =
  'You are a precise writing engine. Follow the instructions in the user message ' +
  'exactly. Output ONLY the requested text — no preamble, no sign-off, no meta ' +
  'commentary, no markdown code fences, no explanation of what you did or why.';

/** True when outputs should be composed by the Claude terminal instead of the local/Vertex brain. */
function useClaudeCompose() {
  const b = (process.env.COMPOSE_BACKEND || '').toLowerCase();
  return b === 'claude' || process.env.CLAUDE_COMPOSE === '1';
}

/**
 * claudeCompose(prompt, opts) → Promise<string>
 * Single-shot text generation via `claude -p`. Rejects on spawn/timeout/parse
 * error or a non-zero exit — callers that want resilience go through compose().
 *
 * opts.claudeModel  Claude alias/id  (default: env CLAUDE_COMPOSE_MODEL || 'sonnet')
 * opts.system       system prompt    (default: DEFAULT_SYSTEM)
 * opts.timeoutMs    kill timeout     (default: env CLAUDE_COMPOSE_TIMEOUT_MS || 120000)
 */
function claudeCompose(prompt, opts = {}) {
  const model     = opts.claudeModel || process.env.CLAUDE_COMPOSE_MODEL || 'sonnet';
  const system    = opts.system || DEFAULT_SYSTEM;
  const timeoutMs = opts.timeoutMs || Number(process.env.CLAUDE_COMPOSE_TIMEOUT_MS) || 120_000;
  const bin       = process.env.CLAUDE_BIN || 'claude';

  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', model,
      '--tools', '',             // disable ALL built-in tools — pure text gen, no permission prompts
      '--strict-mcp-config',     // ignore every MCP server (none supplied)
      '--system-prompt', system, // replace the agent prompt: cheap, focused, no skills/memory
    ];

    let child;
    try {
      child = spawn(bin, args, {
        cwd: os.tmpdir(),        // neutral cwd — no project CLAUDE.md/settings leakage
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new Error(`claude spawn failed: ${e.message}`));
    }

    let out = '', err = '', done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(reject, new Error(`claude compose timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish(reject, new Error(`claude spawn failed: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0) return finish(reject, new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`));
      let j;
      try { j = JSON.parse(out); }
      catch (e) { return finish(reject, new Error(`claude output parse failed: ${e.message} :: ${out.slice(0, 300)}`)); }
      if (j.is_error) return finish(reject, new Error(`claude error: ${String(j.result).slice(0, 300)}`));
      const text = (j.result || '').trim();
      if (!text) return finish(reject, new Error('claude returned empty result'));
      finish(resolve, text);
    });

    child.stdin.on('error', () => {}); // ignore EPIPE if the child dies early
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * compose(prompt, opts) → Promise<string>
 * Unified composition entry. Drop-in for the callVertex() calls on output paths.
 *
 *  - Claude backend enabled → route to claudeCompose(); on ANY failure fall back
 *    to callVertex() (local qwen / Gemini) so an outage never blocks a post,
 *    unless opts.fallback === false.
 *  - Backend disabled → straight to callVertex(): identical to the prior behaviour.
 *
 * opts:
 *   maxTokens       token budget for the callVertex path         (default 2000)
 *   model           model id for the callVertex/Vertex path      (e.g. "gemini-2.5-flash")
 *   claudeModel     Claude alias/id for the Claude path          (default env/'sonnet')
 *   system          Claude system prompt override                (default DEFAULT_SYSTEM)
 *   temperature     passed to callVertex                         (fallback path)
 *   thinkingBudget  passed to callVertex                         (fallback path)
 *   timeoutMs       Claude kill timeout
 *   fallback        false → surface Claude errors instead of falling back (default true)
 *   tag             log label                                    (default 'compose')
 */
async function compose(prompt, opts = {}) {
  const { maxTokens = 2000, fallback = true, tag = 'compose' } = opts;

  if (useClaudeCompose()) {
    try {
      return await claudeCompose(prompt, opts);
    } catch (e) {
      if (!fallback) throw e;
      console.warn(`[${tag}] claude compose failed (${e.message}) — falling back to callVertex`);
    }
  }

  const { callVertex } = require('../vertex');
  const vertexOpts = {};
  if (opts.model)                       vertexOpts.model = opts.model;
  if (opts.temperature !== undefined)   vertexOpts.temperature = opts.temperature;
  if (opts.thinkingBudget !== undefined) vertexOpts.thinkingBudget = opts.thinkingBudget;
  return callVertex(prompt, maxTokens, vertexOpts);
}

// ── reason(): Claude as the REASONING backend for the cognition stack ─────────
// Same mechanism as compose(), but for the "thinking" stages (ponder, deep_dive,
// decision, planner, tracker, process_reflection, evaluate_vocation, reflect)
// that otherwise run on the weak local qwen and defeat their own prompt-level
// guardrails / emit malformed JSON. Gated SEPARATELY (THINK_BACKEND=claude) so
// thinking and composing toggle independently. Cognition is a daily batch (a
// handful of calls/day), so Claude cost/latency is negligible here.
const REASON_SYSTEM =
  'You are a careful reasoning engine for an autonomous agent. Follow the ' +
  'instructions in the user message EXACTLY, including any required output ' +
  'format and constraints. When the message asks for JSON, output ONLY the raw ' +
  'JSON object/array — no prose, no markdown code fences, no commentary before ' +
  'or after. When it asks for a specific single token or word, output only that. ' +
  'Honor every stated rule (e.g. capability limits, forbidden actions).';

/** True when the cognition/reasoning stages should route to the Claude terminal. */
function useClaudeThink() {
  const b = (process.env.THINK_BACKEND || '').toLowerCase();
  return b === 'claude' || process.env.CLAUDE_THINK === '1';
}

/**
 * reason(prompt, opts) → Promise<string>
 * Drop-in for the cognition-path callVertex() calls. Routes to the Claude
 * terminal when THINK_BACKEND=claude; on ANY failure falls back to callVertex
 * (local qwen) so a Claude outage never stalls the daily cognition, unless
 * opts.fallback === false. Backend off → identical to the old callVertex path.
 *
 * opts: maxTokens (callVertex budget, default 4096), model (vertex fallback
 *   model id), claudeModel (default env CLAUDE_THINK_MODEL/'sonnet'), system,
 *   temperature, thinkingBudget, timeoutMs, fallback, tag.
 */
async function reason(prompt, opts = {}) {
  const { maxTokens = 4096, fallback = true, tag = 'reason' } = opts;

  if (useClaudeThink()) {
    try {
      const out = await claudeCompose(prompt, {
        system: opts.system || REASON_SYSTEM,
        claudeModel: opts.claudeModel || process.env.CLAUDE_THINK_MODEL || 'sonnet',
        timeoutMs: opts.timeoutMs || Number(process.env.CLAUDE_THINK_TIMEOUT_MS) || 180_000,
      });
      // Claude sometimes wraps JSON in ```json fences despite instructions; strip
      // leading/trailing code fences so callers' JSON.parse/regex works cleanly.
      return String(out).replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();
    } catch (e) {
      if (!fallback) throw e;
      console.warn(`[${tag}] claude reason failed (${e.message}) — falling back to callVertex`);
    }
  }

  const { callVertex } = require('../vertex');
  const vertexOpts = {};
  if (opts.model)                        vertexOpts.model = opts.model;
  if (opts.temperature !== undefined)    vertexOpts.temperature = opts.temperature;
  if (opts.thinkingBudget !== undefined) vertexOpts.thinkingBudget = opts.thinkingBudget;
  return callVertex(prompt, maxTokens, vertexOpts);
}

module.exports = { compose, reason, claudeCompose, useClaudeCompose, useClaudeThink, DEFAULT_SYSTEM };

// ── CLI: quick manual test — `node runner/lib/compose.js "your prompt"` ─────────
if (require.main === module) {
  (async () => {
    const prompt = process.argv.slice(2).join(' ').trim();
    if (!prompt) { console.error('usage: node runner/lib/compose.js "<prompt>"'); process.exit(2); }
    const backend = useClaudeCompose() ? `claude (${process.env.CLAUDE_COMPOSE_MODEL || 'sonnet'})` : 'callVertex';
    console.error(`[compose] backend: ${backend}`);
    try {
      const t0 = Date.now();
      const text = await compose(prompt, { tag: 'compose-cli' });
      console.error(`[compose] ${Date.now() - t0}ms`);
      process.stdout.write(text + '\n');
    } catch (e) {
      console.error(`[compose] failed: ${e.message}`);
      process.exit(1);
    }
  })();
}
