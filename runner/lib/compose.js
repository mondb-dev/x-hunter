#!/usr/bin/env node
/**
 * runner/lib/compose.js — the Claude inference backend. THE inference backend.
 *
 * INFERENCE POLICY: Claude is the only LLM. There is no local model, no Vertex,
 * no Gemini. Every generation path in the system terminates here — compose() and
 * reason() for the two prompt styles, composeJSON() for schema-constrained
 * output, and vertex.js callVertex() as a compatibility shim for legacy callers.
 *
 * WHY the CLI and not an API SDK: the user drives Claude through the terminal
 * (their existing auth lives in ~/.claude), there's no extra key to manage, and
 * `claude -p` is a stable, non-interactive text endpoint. We invoke it in a
 * stripped-down mode — full system-prompt override + no tools + no MCP — so it
 * behaves as a pure, cheap text generator (~$0.001/call, ~3-4s) rather than a
 * full agent (~$0.11/call from the ~18k-token agent system prompt).
 *
 *   compose(prompt, opts)     → Promise<string>  outbound prose
 *   reason(prompt, opts)      → Promise<string>  cognition/JSON stages
 *   composeJSON(prompt, s, o) → Promise<object>  schema-constrained JSON
 *   claudeCompose(prompt, o)  → Promise<string>  single attempt, no retry
 *
 * RETRY: with no second backend, a transient Claude failure is a lost cycle, so
 * compose()/reason() retry on the errors that are actually transient — 529
 * "Overloaded" and kill-timeouts — with exponential backoff. Quota exhaustion
 * ("out of extra usage") is NOT retried: it resets on a multi-hour window, so
 * in-cycle retries only burn time. See docs/INVENTORY.md → inference.
 *
 * TUNE (.env, all optional):
 *   CLAUDE_COMPOSE_MODEL       Claude alias/id (default: sonnet). opts.claudeModel wins.
 *   CLAUDE_COMPOSE_TIMEOUT_MS  per-call kill timeout (default: 120000).
 *   CLAUDE_RETRIES             attempts per call on transient errors (default: 3).
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

// Claude is the only backend, so these are constants now. They are kept as
// functions because ~10 callers branch on them; the branches are dead but
// harmless, and removing them is a separate mechanical pass.
/** @deprecated Claude is the only inference backend — always true. */
function useClaudeCompose() { return true; }

/**
 * Transient failures worth retrying: upstream capacity (529) and our own kill
 * timeout, which in practice is a slow 529 retry chain inside the CLI. Quota
 * exhaustion is deliberately excluded — it resets on a multi-hour window, so
 * retrying inside a cycle just burns wall-clock before the same failure.
 */
function isTransient(err) {
  const m = String(err && err.message || '');
  if (/out of extra usage|usage limit/i.test(m)) return false;
  return /529|overloaded|compose timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(m);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * withRetry(fn, tag) → Promise<any>
 * Runs fn(), retrying transient failures with exponential backoff + jitter.
 * Non-transient errors surface immediately.
 */
async function withRetry(fn, tag = 'claude') {
  const attempts = Number(process.env.CLAUDE_RETRIES) || 3;
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts || !isTransient(e)) break;
      const backoff = Math.round(1000 * 2 ** (i - 1) * (1 + Math.random()));
      console.warn(`[${tag}] transient failure (${e.message.slice(0, 120)}) — retry ${i}/${attempts - 1} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw last;
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
      try {
        const u = j.usage || {};
        require('./cost_meter').record({ tag: opts.tag || 'compose', model, inTokens: u.input_tokens, outTokens: u.output_tokens, usd: j.total_cost_usd, promptChars: prompt.length, outChars: text.length });
      } catch {}
      finish(resolve, text);
    });

    child.stdin.on('error', () => {}); // ignore EPIPE if the child dies early
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * compose(prompt, opts) → Promise<string>
 * Unified composition entry for outbound prose. Retries transient Claude
 * failures, then throws — there is no second backend to fall back to, and a
 * silent substitution is exactly what the "Claude only" policy forbids.
 *
 * Callers that treat a failed generation as "skip this cycle" should catch;
 * callers that must not post degraded text should let it throw.
 *
 * opts:
 *   claudeModel     Claude alias/id                (default env/'sonnet')
 *   system          system prompt override         (default DEFAULT_SYSTEM)
 *   timeoutMs       kill timeout per attempt
 *   tag             log label                      (default 'compose')
 */
async function compose(prompt, opts = {}) {
  const { tag = 'compose' } = opts;
  return withRetry(() => claudeCompose(prompt, opts), tag);
}

/**
 * composeJSON(prompt, schema, opts) → Promise<object>
 * Schema-constrained JSON. Replaces the Ollama grammar-constrained path
 * (`format: <schema>`), which guaranteed parseable output at the transport
 * layer. Claude has no such guarantee, so we do it in three layers: state the
 * schema in the prompt, strip code fences, and retry once on a parse failure
 * with the parse error fed back in.
 *
 * `schema` is a JSON Schema object — same shape the Ollama path took, so
 * existing SCHEMA constants pass through unchanged.
 */
async function composeJSON(prompt, schema, opts = {}) {
  const { tag = 'composeJSON' } = opts;
  const schemaText = JSON.stringify(schema, null, 2);
  const base =
    `${prompt}\n\n` +
    `Return ONLY a JSON object conforming to this JSON Schema. No prose, no ` +
    `markdown fences, no commentary:\n${schemaText}`;

  const parse = (raw) => {
    const cleaned = String(raw)
      .replace(/^\s*```[a-z]*\s*\n?/i, '')
      .replace(/\n?\s*```\s*$/i, '')
      .trim();
    return JSON.parse(cleaned);
  };

  const first = await compose(base, { ...opts, system: opts.system || REASON_SYSTEM, tag });
  try {
    return parse(first);
  } catch (e) {
    console.warn(`[${tag}] JSON parse failed (${e.message}) — one corrective retry`);
    const retryPrompt =
      `${base}\n\nYour previous response was NOT valid JSON (${e.message}). ` +
      `Return the corrected raw JSON object only.`;
    return parse(await compose(retryPrompt, { ...opts, system: opts.system || REASON_SYSTEM, tag }));
  }
}

// ── reason(): Claude as the REASONING backend for the cognition stack ─────────
// Same mechanism as compose(), but for the "thinking" stages (ponder, deep_dive,
// decision, planner, tracker, process_reflection, evaluate_vocation, reflect)
// that used to run on a weak local model and defeat their own prompt-level
// guardrails / emit malformed JSON. Cognition is a daily batch (a handful of
// calls/day), so Claude cost/latency is negligible here.
const REASON_SYSTEM =
  'You are a careful reasoning engine for an autonomous agent. Follow the ' +
  'instructions in the user message EXACTLY, including any required output ' +
  'format and constraints. When the message asks for JSON, output ONLY the raw ' +
  'JSON object/array — no prose, no markdown code fences, no commentary before ' +
  'or after. When it asks for a specific single token or word, output only that. ' +
  'Honor every stated rule (e.g. capability limits, forbidden actions).';

/** @deprecated Claude is the only inference backend — always true. */
function useClaudeThink() { return true; }

/**
 * reason(prompt, opts) → Promise<string>
 * The cognition-path entry (ponder, deep_dive, decision, planner, tracker,
 * process_reflection, evaluate_vocation, reflect). Same transport as compose(),
 * different system prompt and a longer default timeout — these prompts are
 * bigger and the stages are a daily batch, so latency is cheap here.
 *
 * Retries transient failures, then throws. No fallback backend exists.
 *
 * opts: claudeModel (default env CLAUDE_THINK_MODEL/'sonnet'), system,
 *   timeoutMs (default env CLAUDE_THINK_TIMEOUT_MS/180000), tag.
 */
async function reason(prompt, opts = {}) {
  const { tag = 'reason' } = opts;
  const out = await withRetry(() => claudeCompose(prompt, {
    ...opts,
    system: opts.system || REASON_SYSTEM,
    claudeModel: opts.claudeModel || process.env.CLAUDE_THINK_MODEL || 'sonnet',
    timeoutMs: opts.timeoutMs || Number(process.env.CLAUDE_THINK_TIMEOUT_MS) || 180_000,
  }), tag);
  // Claude sometimes wraps JSON in ```json fences despite instructions; strip
  // leading/trailing code fences so callers' JSON.parse/regex works cleanly.
  return String(out).replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();
}

module.exports = {
  compose, reason, composeJSON, claudeCompose, withRetry,
  useClaudeCompose, useClaudeThink, DEFAULT_SYSTEM, REASON_SYSTEM,
};

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
