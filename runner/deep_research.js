#!/usr/bin/env node
'use strict';
/**
 * runner/deep_research.js — a Claude-driven deep-research TOOL.
 *
 * Composes the agent's existing retrieval tools into a plan → execute →
 * (adaptive fetch) → synthesize loop:
 *   1. PLAN   — Claude drafts an explicit research plan (approach + tool steps).
 *   2. EXECUTE— runs each planned step against a real tool:
 *        recall  → memory/observations (lib/recall)
 *        posts   → full-text search of Sebastian's observed feed (scraper DB)
 *        search  → web search via HelmStack/DuckDuckGo (lib/helmstack_fetch)
 *        fetch   → page text of a specific URL via HelmStack (lib/helmstack_fetch)
 *   3. FETCH  — Claude picks the most promising URLs surfaced by searches and
 *               reads them (one adaptive round).
 *   4. SYNTH  — Claude writes a cited answer with a confidence level + caveats.
 *
 * All inference (plan, url-selection, synthesis) runs on the Claude terminal via
 * reason() (THINK_BACKEND=claude), falling back to the local brain.
 *
 * Usage:
 *   node runner/deep_research.js "<question>" [--plan-only] [--max-fetch=4]
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
if (fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const https = require('https');
const { reason } = require('./lib/compose');
const { fetchPageText, searchWeb } = require('./lib/helmstack_fetch');
const { recallText } = require('./lib/recall');
const log = (m) => console.log(`[deep_research] ${m}`);

/** Plain https GET → parsed JSON (follows one redirect). Resolves null on error. */
function httpJson(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(httpJson(res.headers.location, { timeoutMs }));
      }
      let raw = ''; res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ── Tool registry: the retrieval primitives the plan can call ─────────────────
const TOOLS = {
  async recall(input) {
    const t = await recallText(input, { maxChars: 1200 }).catch(() => '');
    return t || '(no memory match)';
  },
  async posts(input) {
    try {
      const { loadScraperDb } = require('./lib/db_backend');
      const rows = await loadScraperDb().search(input, 8);
      if (!rows || !rows.length) return `(no observed posts matching "${input}")`;
      return rows.map((r) => `@${r.username}: ${(r.text || '').slice(0, 200)}`).join('\n');
    } catch (e) { return `(posts search error: ${e.message})`; }
  },
  async search(input) {
    const res = await searchWeb(input, { max: 6 });
    if (!res.length) return { text: `(no web results for "${input}")`, urls: [] };
    return {
      text: res.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n'),
      urls: res.map((r) => r.url),
    };
  },
  async fetch(input) {
    const t = await fetchPageText(input, { maxChars: 3500 });
    return t || `(could not fetch ${input})`;
  },
  // On-chain rug/holder-concentration analysis for a Solana token mint, via the
  // RugCheck API (structured: authorities, top-holder concentration + insider
  // flags, LP lock, liquidity, risk flags) — the reliable source for this, vs
  // scraping explorer SPAs. Input: a Solana mint address.
  async rugcheck(input) {
    const mint = (String(input).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/) || [])[0];
    if (!mint) return '(rugcheck: no valid mint address in input)';
    const r = await httpJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (!r || typeof r !== 'object') return `(rugcheck: no data for ${mint})`;
    const holders = (r.topHolders || []).slice(0, 12).map((h) =>
      `${(h.pct != null ? h.pct.toFixed(2) : '?')}%${h.insider ? ' [insider]' : ''}${h.owner || h.address ? ' ' + String(h.owner || h.address).slice(0, 6) : ''}`);
    return JSON.stringify({
      mint,
      score_normalised: r.score_normalised,
      rugged: r.rugged,
      mintAuthorityRenounced: r.mintAuthority == null,   // renounced = good (can't mint more)
      freezeAuthorityRenounced: r.freezeAuthority == null, // renounced = good (can't freeze holders)
      creator: r.creator,
      creatorBalancePct: r.creatorBalance != null && r.token && r.token.supply ? +(100 * r.creatorBalance / r.token.supply).toFixed(2) : undefined,
      totalHolders: r.totalHolders,
      totalLPProviders: r.totalLPProviders,
      totalMarketLiquidity: r.totalMarketLiquidity,
      lpLocked: (r.markets || []).map((m) => m.lp && m.lp.lpLockedPct).filter((x) => x != null),
      graphInsidersDetected: r.graphInsidersDetected,   // # insider CLUSTERS RugCheck detected
      insiderNetworks: (r.insiderNetworks || []).map((n) => ({ size: n.size, pct: n.tokenAmountPct, type: n.type })),
      risks: (r.risks || []).map((x) => `${x.name} [${x.level}]${x.value ? ' ' + x.value : ''}`),
      topHolders: holders,
    }, null, 1);
  },
};

const TOOL_DESCR =
  'recall — Sebastian\'s own memory / past observations (semantic+FTS); input: a query.\n' +
  'posts  — full-text search of the X feed Sebastian has observed; input: keywords.\n' +
  'search — web search (returns titles/URLs/snippets); input: a search query.\n' +
  'fetch  — read the page text of ONE specific URL; input: an https URL.\n' +
  'rugcheck — on-chain analysis of a SOLANA TOKEN MINT via RugCheck: risk score, mint/freeze authority (null=renounced), top-holder concentration + insider flags, INSIDER CLUSTER count (graphInsidersDetected/insiderNetworks), LP lock, liquidity, holder count. Input: a Solana mint address. Use this for any token rug/cluster/holder-concentration question — do NOT scrape explorer pages for this.';

async function plan(question) {
  const prompt =
`You are Sebastian Hunter's research planner. Draft an explicit plan to answer the QUESTION using ONLY these tools:
${TOOL_DESCR}

QUESTION: ${question}

Think about the best sequence: start from what's already known (recall/posts), then search, then fetch authoritative sources. For 'fetch' steps you may construct KNOWN canonical URLs (e.g. official explorers/registries) directly from the question; URLs discovered by 'search' will be fetched in a later adaptive step, so you don't need to guess those.

Output ONLY JSON (no fences):
{
  "goal": "restate what a good answer must establish",
  "approach": "1-2 sentence strategy",
  "steps": [ {"tool":"recall|posts|search|fetch","input":"the query or URL","rationale":"why this step"} ],
  "success_criteria": "what would make the answer confident",
  "caveats": "what could make this unknowable or uncertain"
}`;
  const raw = await reason(prompt, { maxTokens: 1500, tag: 'dr-plan' });
  return JSON.parse(raw);
}

async function execute(steps) {
  const findings = [];
  const discoveredUrls = [];
  for (const s of steps) {
    if (!TOOLS[s.tool]) { findings.push({ ...s, result: `(unknown tool ${s.tool})` }); continue; }
    log(`step: ${s.tool}("${String(s.input).slice(0, 70)}")`);
    let out = await TOOLS[s.tool](s.input);
    if (s.tool === 'search' && out && out.urls) { discoveredUrls.push(...out.urls); out = out.text; }
    findings.push({ tool: s.tool, input: s.input, result: String(out).slice(0, 3500) });
  }
  return { findings, discoveredUrls: [...new Set(discoveredUrls)] };
}

async function adaptiveFetch(question, findings, urls, maxFetch) {
  if (!urls.length || maxFetch <= 0) return [];
  const pick = await reason(
    `QUESTION: ${question}\nCandidate URLs from searches:\n${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n\nPick the up-to-${maxFetch} MOST authoritative/relevant URLs to read in full. Output ONLY a JSON array of the chosen URLs.`,
    { maxTokens: 400, tag: 'dr-pick' }
  ).then((r) => { try { return JSON.parse(r); } catch { return []; } }).catch(() => []);
  const chosen = (Array.isArray(pick) ? pick : []).filter((u) => /^https?:\/\//.test(u)).slice(0, maxFetch);
  const out = [];
  for (const u of chosen) { log(`fetch: ${u.slice(0, 70)}`); out.push({ tool: 'fetch', input: u, result: (await TOOLS.fetch(u)).slice(0, 3500) }); }
  return out;
}

async function synthesize(question, plan, findings) {
  const dossier = findings.map((f) => `### ${f.tool}: ${f.input}\n${f.result}`).join('\n\n');
  const prompt =
`You are Sebastian Hunter. Answer the QUESTION using ONLY the RESEARCH DOSSIER below (do not invent facts). Be specific, cite the source (tool + URL) for each claim, state a confidence level (high/medium/low), and honestly flag what remains unknown.

QUESTION: ${question}

SUCCESS CRITERIA: ${plan.success_criteria || '(none)'}
CAVEATS TO CHECK: ${plan.caveats || '(none)'}

RESEARCH DOSSIER:
${dossier}

Write a concise findings report: the answer (or best-supported hypothesis), the evidence with citations, confidence, and open questions.`;
  return reason(prompt, { maxTokens: 1800, tag: 'dr-synth' });
}

async function deepResearch(question, { maxFetch = 4, planOnly = false } = {}) {
  log(`question: ${question}`);
  const p = await plan(question);
  log(`plan: ${(p.steps || []).length} step(s) — ${p.approach || ''}`);
  if (planOnly) return { plan: p };
  const { findings, discoveredUrls } = await execute(p.steps || []);
  const fetched = await adaptiveFetch(question, findings, discoveredUrls, maxFetch);
  const report = await synthesize(question, p, [...findings, ...fetched]);
  return { plan: p, findings: [...findings, ...fetched], report };
}

module.exports = { deepResearch, plan, TOOLS };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const planOnly = args.includes('--plan-only');
    const mf = (args.find((a) => a.startsWith('--max-fetch=')) || '').split('=')[1];
    const question = args.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!question) { console.error('usage: node runner/deep_research.js "<question>" [--plan-only] [--max-fetch=N]'); process.exit(2); }
    try {
      const res = await deepResearch(question, { planOnly, maxFetch: mf ? Number(mf) : 4 });
      if (planOnly) { console.log('\n=== PLAN ===\n' + JSON.stringify(res.plan, null, 2)); }
      else { console.log('\n=== REPORT ===\n' + res.report); }
      process.exit(0);
    } catch (e) { console.error(`[deep_research] failed: ${e.message}`); process.exit(1); }
  })();
}
