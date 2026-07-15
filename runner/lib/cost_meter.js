'use strict';
/**
 * runner/lib/cost_meter.js — lightweight LLM spend meter.
 *
 * Sebastian's LLM usage was entirely untracked — no call count, no token tally,
 * no idea what he costs to run. This records one line per LLM call to
 * state/cost_ledger.jsonl (append-only, so separate runner processes don't race)
 * and rolls it up on demand. Estimates cost from token counts × the per-model
 * prices in state/cost_config.json; when a caller doesn't know token counts it
 * approximates from text length (~4 chars/token).
 *
 *   record({ tag, model, inTokens?, outTokens?, promptChars?, outChars? })
 *   rollup({ days = 30 }) -> { usd, calls, dailyAvgUsd, byModel, byTag, since }
 *
 * DESIGN: record() must NEVER throw into an LLM caller — every call is wrapped by
 * the LLM wrappers in a try/catch, and record() itself swallows its own errors.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const LEDGER = process.env.COST_LEDGER_PATH || path.join(config.STATE_DIR, 'cost_ledger.jsonl');
const CONFIG = path.join(config.STATE_DIR, 'cost_config.json');

let _pricing = null;
function pricing() {
  if (_pricing) return _pricing;
  try { _pricing = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).llm_pricing_usd_per_1k_tokens || {}; }
  catch { _pricing = {}; }
  return _pricing;
}

function rateFor(model) {
  const p = pricing();
  return p[model] || p[normalizeModel(model)] || p._default || { in: 0.0005, out: 0.0015 };
}

function normalizeModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m || m === 'local' || m.includes('qwen') || m.includes('ollama')) return 'local';
  if (m.includes('claude') || m === 'sonnet' || m === 'opus' || m === 'haiku') return 'claude';
  if (m.includes('pro')) return 'gemini-2.5-pro';
  if (m.includes('flash') || m.includes('gemini')) return 'gemini-2.5-flash';
  return '_default';
}

const estTokens = (chars) => Math.max(0, Math.round((Number(chars) || 0) / 4));

/**
 * Record one LLM call. Never throws. If `usd` is supplied (e.g. Claude Code's
 * reported total_cost_usd) it is used verbatim; otherwise cost is estimated from
 * tokens × the configured per-model price.
 */
function record({ tag = 'unknown', model = 'local', inTokens, outTokens, promptChars, outChars, usd } = {}) {
  try {
    const key = normalizeModel(model);
    const inTok = inTokens != null ? inTokens : estTokens(promptChars);
    const outTok = outTokens != null ? outTokens : estTokens(outChars);
    const r = rateFor(key);
    if (usd == null) usd = (inTok / 1000) * (r.in || 0) + (outTok / 1000) * (r.out || 0);
    fs.appendFileSync(LEDGER, JSON.stringify({
      ts: new Date().toISOString(), tag, model: key, inTok, outTok, usd: Number(usd.toFixed(6)),
    }) + '\n');
  } catch { /* metering must never break a caller */ }
}

/** Aggregate the last `days` of the ledger. Never throws. */
function rollup({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const out = { usd: 0, calls: 0, inTok: 0, outTok: 0, byModel: {}, byTag: {}, since, days };
  let lines = [];
  try { lines = fs.readFileSync(LEDGER, 'utf-8').split('\n').filter(Boolean); } catch { return { ...out, dailyAvgUsd: 0 }; }
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.ts || e.ts < since) continue;
    out.usd += e.usd || 0; out.calls += 1; out.inTok += e.inTok || 0; out.outTok += e.outTok || 0;
    (out.byModel[e.model] = out.byModel[e.model] || { calls: 0, usd: 0 }).calls += 1;
    out.byModel[e.model].usd += e.usd || 0;
    (out.byTag[e.tag] = out.byTag[e.tag] || { calls: 0, usd: 0 }).calls += 1;
    out.byTag[e.tag].usd += e.usd || 0;
  }
  out.usd = Number(out.usd.toFixed(4));
  out.dailyAvgUsd = Number((out.usd / days).toFixed(4));
  return out;
}

/** Drop ledger lines older than `keepDays` to bound file size. Returns kept count. */
function prune({ keepDays = 90 } = {}) {
  const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString();
  try {
    const kept = fs.readFileSync(LEDGER, 'utf-8').split('\n').filter(Boolean)
      .filter((l) => { try { return JSON.parse(l).ts >= cutoff; } catch { return false; } });
    fs.writeFileSync(LEDGER, kept.join('\n') + (kept.length ? '\n' : ''));
    return kept.length;
  } catch { return 0; }
}

module.exports = { record, rollup, prune, normalizeModel };
