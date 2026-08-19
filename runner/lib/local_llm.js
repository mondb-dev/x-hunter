'use strict';
/**
 * runner/lib/local_llm.js — Ollama transport for CHEAP, BOUNDED calls only.
 *
 * Deliberately narrow. Claude remains the only backend for anything Sebastian
 * says in public (see runner/llm.js INFERENCE POLICY). This module exists for
 * the opposite kind of work: high-frequency classification whose output is a
 * digit or a label, where a 3.8B local model is adequate, ~free, and — the
 * reason it earns its keep — fast. `lib/content_relevance.js` had to raise its
 * scorer timeout to 90s because the Claude CLI is a subprocess and "cannot
 * answer that fast under any load"; that cost is paid once per candidate post,
 * every engagement cycle, on both X and LinkedIn.
 *
 * WHY THIS IS NOT A FALLBACK (the 2026-07-30 lesson, commit b158bd33a):
 * the old design chained backends, and when Claude 429'd it produced
 * "Claude 429s -> local 404s -> retry -> 18 failures in one cycle". So:
 *
 *   1. Routing is EXPLICIT and per-call-site. Nothing silently reroutes here,
 *      and nothing here ever escalates to Claude. A caller picks one backend.
 *   2. Failure is LOCAL. On any error the caller degrades within its own cheap
 *      path (the scorer falls back to its lexical signal), never to a paid one.
 *   3. Absence is LOUD. The store was wiped on 2026-07-28 and every local path
 *      "silently degraded or died" for ~2.3 days. isAvailable() probes the model
 *      by name so a missing/renamed model is a reported condition, not a silent
 *      zero. Callers are expected to log the reason once per run.
 *
 * MEASURED BEHAVIOUR (phi4-mini, 18 real feed items, 2026-08-19) — this is why
 * the default mode is 'prefilter' and not 'only':
 *   - It is a good NOISE FILTER. Commercial/product chatter is correctly zeroed
 *     (a Reddit feature launch, a TechCrunch ticket ad, a Peacock price rise).
 *     Handwritten LinkedIn noise — birthdays, job announcements, "5 habits of
 *     effective leaders" — is likewise zeroed.
 *   - It is a BAD RANKER. Across those items it emitted only 0 and 2 — never 1,
 *     never 3 — and rated a ferry disaster and licensure-exam results a 2. With
 *     minScore=2 it would wave both through as things worth commenting on.
 *   - Prompt shape carries it. An abbreviated prompt returned a constant "2" for
 *     everything; the production prompt (with explicit "job updates,
 *     congratulations, ads = 0" anti-examples) is what produces the separation.
 *     Do not "tidy" those anti-examples out of the scorer prompt.
 *
 * COLD START is ~110s on this M4/16GB (2.5GB model, first load), then ~0.2-1.4s
 * warm. Ollama unloads after keep_alive (default 5m), and engagement runs every
 * few hours — so a run typically pays the cold start once. isAvailable() warms
 * the model so that cost lands on the probe, not on the first scored post.
 *
 * Env:
 *   LOCAL_LLM_ENABLED  '1' to allow local routing at all (default off).
 *   LOCAL_LLM_MODE     'prefilter' (default) — local drops obvious 0s, Claude
 *                      ranks the survivors. 'only' — local does all scoring
 *                      (ranking collapses to 0/2; use when Claude quota is
 *                      exhausted and degraded engagement beats none).
 *   LOCAL_LLM_MODEL    ollama model tag (default 'phi4-mini').
 *   LOCAL_LLM_URL      ollama base URL (default http://127.0.0.1:11434).
 */

const DEFAULT_URL = process.env.LOCAL_LLM_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.LOCAL_LLM_MODEL || 'phi4-mini';

/** Opt-in gate. Local routing is OFF unless explicitly enabled. */
function isEnabled() {
  return process.env.LOCAL_LLM_ENABLED === '1';
}

/** 'prefilter' (default) | 'only' — see header for the measurements behind this. */
function mode() {
  return process.env.LOCAL_LLM_MODE === 'only' ? 'only' : 'prefilter';
}

/**
 * Probe the daemon AND the specific model tag.
 *
 * Checking only that the server answers is what made the 2026-07-28 wipe
 * invisible: `ollama serve` kept returning 200 with `{"models":[]}` for days
 * while every model 404'd. So this resolves the tag itself.
 *
 * @returns {Promise<{ok:boolean, reason?:string, models?:string[]}>} never throws
 */
// 15s, not 3s: /api/tags answers in ~0.2s idle, but Ollama's HTTP server blocks
// while it is loading weights, so a tight probe times out exactly when a model
// IS present and warming — reporting "unreachable" for the healthy case.
async function isAvailable({ timeoutMs = 15_000, warm = true, warmTimeoutMs = 180_000 } = {}) {
  if (!isEnabled()) return { ok: false, reason: 'LOCAL_LLM_ENABLED != 1' };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${DEFAULT_URL}/api/tags`, { signal: ctl.signal });
    } finally { clearTimeout(t); }
    if (!res.ok) return { ok: false, reason: `ollama http_${res.status}` };
    const j = await res.json();
    const names = (j.models || []).map((m) => String(m.name || m.model || ''));
    // Ollama reports "phi4-mini:latest" for a bare "phi4-mini" pull.
    const found = names.some((n) => n === MODEL || n.split(':')[0] === MODEL.split(':')[0]);
    if (!found) {
      return { ok: false, reason: `model '${MODEL}' not pulled (have: ${names.join(', ') || 'none'})`, models: names };
    }
    if (warm) {
      // Load the weights HERE so the ~110s cold start is paid by the probe, not
      // by the first scored post (which would blow a tight per-call timeout and
      // silently fall through to the lexical branch — the exact failure this
      // module exists to avoid).
      const t0 = Date.now();
      try {
        await generateLocal('Reply with: 1', { maxTokens: 2, timeoutMs: warmTimeoutMs, tag: 'warmup' });
      } catch (e) {
        return { ok: false, reason: `model present but warmup failed in ${Date.now() - t0}ms: ${e.message}`, models: names };
      }
      return { ok: true, models: names, warmedMs: Date.now() - t0 };
    }
    return { ok: true, models: names };
  } catch (e) {
    return { ok: false, reason: `ollama unreachable: ${e.message}` };
  }
}

/**
 * Single-shot local generation. Rejects on any failure — callers degrade to
 * their own cheap path and MUST NOT escalate to a paid backend (see header).
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.maxTokens=8]      mapped to Ollama num_predict
 * @param {number} [opts.temperature=0]
 * @param {string[]} [opts.stop]           stop sequences
 * @param {string} [opts.tag='local']      cost-ledger tag
 * @returns {Promise<string>} trimmed completion
 */
async function generateLocal(prompt, opts = {}) {
  const {
    timeoutMs = 20_000,
    maxTokens = 8,
    temperature = 0,
    stop = null,
    tag = 'local',
  } = opts;

  if (!isEnabled()) throw new Error('local_llm disabled (LOCAL_LLM_ENABLED != 1)');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${DEFAULT_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        options: { temperature, num_predict: maxTokens, ...(stop ? { stop } : {}) },
      }),
    });
  } catch (e) {
    throw new Error(`local_llm request failed: ${e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`local_llm http_${res.status}`);
  const j = await res.json();
  const text = String(j.response || '').trim();

  // Local inference is free, but record it so the burn-rate self-model still
  // sees the call volume. normalizeModel() maps this to the zero-rate 'local'
  // bucket (cost_meter.js).
  try {
    require('./cost_meter').record({
      tag, model: MODEL,
      inTokens: j.prompt_eval_count, outTokens: j.eval_count,
      promptChars: prompt.length, outChars: text.length,
    });
  } catch { /* metering must never break inference */ }

  if (!text) throw new Error('local_llm returned empty text');
  return text;
}

module.exports = { generateLocal, isAvailable, isEnabled, mode, MODEL, DEFAULT_URL };
