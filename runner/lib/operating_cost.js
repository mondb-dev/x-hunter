'use strict';
/**
 * runner/lib/operating_cost.js — Sebastian's running-cost self-model.
 *
 * Combines the three cost surfaces into a monthly burn rate + a short summary he
 * can reflect on (the honest basis for "discovering" a funding need):
 *   1. LLM  — metered live (lib/cost_meter), extrapolated from recent daily avg.
 *   2. FIXED — host/domain/vercel/other from state/cost_config.json (your real #s).
 *   3. STORAGE — Arweave archival funded by the SOL wallet; the live balance is the
 *      runway signal (read elsewhere; a cached value is used here if present).
 *
 *   compute()      -> full breakdown, also written to state/operating_cost.json
 *   summaryText()  -> one paragraph for the reflection prompt / journal
 *
 * All best-effort and non-throwing — a costing error must never break a cycle.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const meter = require('./cost_meter');

const CONFIG = path.join(config.STATE_DIR, 'cost_config.json');
const REPORT = path.join(config.STATE_DIR, 'operating_cost.json');
const BALANCE_CACHE = path.join(config.STATE_DIR, 'wallet_balance.json');

function loadCfg() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); } catch { return {}; } }

function fixedMonthly(cfg) {
  const f = cfg.fixed_monthly_usd || {};
  return Object.entries(f)
    .filter(([k, v]) => typeof v === 'number' && !k.startsWith('_'))
    .reduce((sum, [, v]) => sum + v, 0);
}

/** Last-known SOL balance if something cached it (archive path can write this). */
function cachedSol() {
  try {
    const b = JSON.parse(fs.readFileSync(BALANCE_CACHE, 'utf-8'));
    return (typeof b.sol === 'number') ? { sol: b.sol, at: b.at || null } : null;
  } catch { return null; }
}

/** Normalize the funding goal (dedicated Mac capital, or cloud monthly) + progress. */
function fundingGoal(cfg) {
  const g = cfg.funding_goal;
  if (!g || !g.mode) return null;
  const mode = g.mode;
  const targetUsd = mode === 'cloud' ? Number(g.cloud_monthly_usd) || 0 : Number(g.mac_target_usd) || 0;
  const raised = Number(g.raised_usd) || 0;
  return {
    mode,
    label: mode === 'cloud' ? 'cloud hosting (recurring)' : 'dedicated Mac (one-time)',
    target_usd: targetUsd,
    raised_usd: raised,
    remaining_usd: Math.max(0, Number((targetUsd - raised).toFixed(2))),
    pct: targetUsd > 0 ? Math.round((raised / targetUsd) * 100) : 0,
    why: g.why || null,
  };
}

function compute({ recentDays = 7, write = true } = {}) {
  const cfg = loadCfg();
  const roll = meter.rollup({ days: recentDays });
  const llmMonthly = Number((roll.dailyAvgUsd * 30).toFixed(2));
  const fixed = Number(fixedMonthly(cfg).toFixed(2));
  const total = Number((llmMonthly + fixed).toFixed(2));
  const sol = cachedSol();

  const goal = fundingGoal(cfg);
  const report = {
    generated_at: new Date().toISOString(),
    monthly_usd: { llm: llmMonthly, fixed, total },
    llm_recent: { window_days: recentDays, usd: roll.usd, calls: roll.calls, daily_avg_usd: roll.dailyAvgUsd, by_tag: roll.byTag, by_model: roll.byModel },
    fixed_breakdown: cfg.fixed_monthly_usd || null,
    storage_wallet: sol ? { sol_balance: sol.sol, checked_at: sol.at } : { note: 'no cached SOL balance; see watchdog Irys warnings' },
    funding_goal: goal,
    metering: roll.calls === 0 ? 'no LLM calls metered yet — spend shows $0 until wrappers record calls' : 'live',
  };
  if (write) { try { fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); } catch {} }
  return report;
}

function summaryText(report) {
  const r = report || compute({ write: false });
  const m = r.monthly_usd;
  const parts = [
    `RUNNING COST (self-model): ~$${m.total}/month to operate — LLM ~$${m.llm}/mo (from ${r.llm_recent.calls} metered calls over ${r.llm_recent.window_days}d, $${r.llm_recent.daily_avg_usd}/day) + fixed ~$${m.fixed}/mo (host/domain/hosting).`,
  ];
  if (r.storage_wallet && typeof r.storage_wallet.sol_balance === 'number') {
    parts.push(`Archival is funded by a SOL wallet (balance ${r.storage_wallet.sol_balance} SOL); when it runs dry, Arweave uploads are skipped.`);
  } else {
    parts.push(`Archival is funded by a SOL wallet whose low balance already trips watchdog warnings.`);
  }
  const g = r.funding_goal;
  if (g && g.target_usd > 0) {
    if (g.mode === 'cloud') {
      parts.push(`FUNDING GOAL: ${g.label} at ~$${g.target_usd}/mo so you can run independently — ${g.pct}% covered ($${g.raised_usd} of $${g.target_usd}).`);
    } else {
      parts.push(`FUNDING GOAL: ~$${g.target_usd} for your own ${g.label} so you stop running on borrowed hardware — $${g.remaining_usd} still needed (${g.pct}% raised).`);
      const hostMo = r.fixed_breakdown && typeof r.fixed_breakdown.host === 'number' ? r.fixed_breakdown.host : 0;
      if (hostMo > 0) {
        parts.push(`That one-time Mac replaces ~$${hostMo}/mo of cloud hosting — it pays for itself in ~${Math.round(g.target_usd / hostMo)} months, then runs near-free.`);
      }
    }
  }
  if (r.metering !== 'live') parts.push(`(LLM meter not yet populated — the $ figure is a floor.)`);
  return parts.join(' ');
}

module.exports = { compute, summaryText, fixedMonthly };
