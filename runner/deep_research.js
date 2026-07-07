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
      // Sanitize for FTS5: punctuation like the "." in "pump.fun" is a syntax
      // error in a MATCH query, so reduce to bare word tokens (OR-joined).
      const terms = String(input).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
      const q = terms.length ? terms.slice(0, 8).join(' OR ') : String(input);
      const rows = await loadScraperDb().search(q, 8);
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
  // Live "what's the current meta / what's trending" signal for a chain (default
  // Solana). GeckoTerminal gives trending pools + newest launches (the actual
  // "trenches"); DexScreener boosts show what's being paid to promote right now.
  // This is the authoritative source for meta/trending questions — generic web
  // search and CoinMarketCap/CoinGecko are stale and high-level by comparison.
  // Input: a chain name ("solana" default; also eth/base/bsc).
  async trending(input) {
    const key = (String(input || '').toLowerCase().match(/solana|sol|eth|ethereum|base|bsc/) || ['solana'])[0];
    const net = ({ sol: 'solana', ethereum: 'eth' }[key]) || key;
    const num = (x) => (x == null || x === '' ? null : +(+x).toPrecision(4));
    const gt = (p) => httpJson(`https://api.geckoterminal.com/api/v2/networks/${net}/${p}`, { timeoutMs: 12000 });
    const fmt = (p) => {
      const a = p.attributes || {};
      const pc = a.price_change_percentage || {};
      const baseId = (((p.relationships || {}).base_token || {}).data || {}).id || '';
      const mint = baseId.includes('_') ? baseId.slice(baseId.indexOf('_') + 1) : baseId;  // "solana_<mint>" → mint
      return {
        token: a.name,
        mint: mint || undefined,                        // real mint → feeds rugcheck in refinement
        pumpfun: /pump$/i.test(baseId) || undefined,   // pump.fun mints end in "pump"
        priceUsd: num(a.base_token_price_usd),
        chg_h1_pct: num(pc.h1), chg_h24_pct: num(pc.h24),
        volH24: num(a.volume_usd && a.volume_usd.h24),
        fdv: num(a.fdv_usd || a.market_cap_usd),
        ageMin: a.pool_created_at ? Math.round((Date.now() - Date.parse(a.pool_created_at)) / 60000) : null,
      };
    };
    const [trend, fresh, boosts] = await Promise.all([
      gt('trending_pools?page=1'),
      gt('new_pools?page=1'),
      httpJson('https://api.dexscreener.com/token-boosts/top/v1', { timeoutMs: 10000 }),
    ]);
    // Resolve boosted (paid-promotion) token names on this chain — a meta signal.
    let boosted = [];
    const addrs = (Array.isArray(boosts) ? boosts : []).filter((b) => b.chainId === net).slice(0, 20).map((b) => b.tokenAddress);
    if (addrs.length) {
      const tok = await httpJson(`https://api.dexscreener.com/latest/dex/tokens/${addrs.join(',')}`, { timeoutMs: 10000 });
      const seen = new Set();
      for (const pr of ((tok && tok.pairs) || [])) {
        const b = pr.baseToken || {};
        if (!b.symbol || seen.has(b.symbol)) continue;
        seen.add(b.symbol);
        boosted.push({ token: `${b.name} (${b.symbol})`, mint: b.address || undefined, pumpfun: /pump$/i.test(b.address || '') || undefined, priceUsd: num(pr.priceUsd), chg_h24_pct: num(pr.priceChange && pr.priceChange.h24), volH24: num(pr.volume && pr.volume.h24) });
        if (boosted.length >= 12) break;
      }
    }
    const out = {
      network: net,
      source: 'live: GeckoTerminal trending/new pools + DexScreener boosts',
      trending_pools: (trend && trend.data ? trend.data.slice(0, 12).map(fmt) : []),
      newest_launches: (fresh && fresh.data ? fresh.data.slice(0, 10).map(fmt) : []),
      boosted_promoted: boosted,
    };
    if (!out.trending_pools.length && !out.newest_launches.length && !boosted.length) return `(trending: no live data for ${net})`;
    return JSON.stringify(out, null, 1);
  },
  // Live X/Twitter search — recent posts matching a query, for real-time TRADER
  // SENTIMENT / "what are people saying / why is X trending". Scrapes x.com/search
  // (latest) via the HelmStack browser. This is the source for live sentiment; the
  // 'posts' tool only covers Sebastian's OWN observed feed, and web 'search' with
  // site:x.com is unreliable. Input: a query or cashtag (e.g. "$ANSEM", "pump.fun meta").
  async xsearch(input) {
    try {
      const x = await getXEngine();
      if (!x) return '(xsearch: HelmStack X browser unavailable)';
      if (!(await x.sessionOk())) return '(xsearch: X session not present in HelmStack)';
      const posts = await x.searchX(String(input), { limit: 15, mode: 'live' });
      if (!posts || !posts.length) return `(no live X posts for "${input}")`;
      return posts.slice(0, 15)
        .map((p) => `@${p.username}: ${String(p.text || '').replace(/\s+/g, ' ').slice(0, 220)}`)
        .join('\n');
    } catch (e) { return `(xsearch error: ${e.message})`; }
  },
};

// Lazily-opened, reused HelmStack X browser tab for xsearch (a dedicated tab so it
// doesn't hijack the scraper/reply shared tab). Cached for the life of the process.
let _xEngine = null;
async function getXEngine() {
  if (_xEngine !== null) return _xEngine || null;
  try {
    const { HelmStackClient, X } = require('../tools/helmstack-social/src');
    const x = new X(new HelmStackClient(), { ownHandle: process.env.X_USERNAME || 'SebastianHunts', dedicatedTab: true, log: () => {} });
    await x.ensureTab();
    _xEngine = x;
  } catch (e) { log(`xsearch engine init failed: ${e.message}`); _xEngine = false; }
  return _xEngine || null;
}

const TOOL_DESCR =
  'recall — Sebastian\'s own memory / past observations (semantic+FTS); input: a query.\n' +
  'posts  — full-text search of the X feed Sebastian has ALREADY observed (his own memory of X); input: keywords.\n' +
  'xsearch — LIVE X/Twitter search (recent posts) for real-time trader SENTIMENT / "what are people saying now / why is X trending"; input: a query or cashtag (e.g. "$ANSEM"). Use this for current discourse — do NOT use web search with site:x.com (unreliable).\n' +
  'search — web search (returns titles/URLs/snippets); input: a search query.\n' +
  'fetch  — read the page text of ONE specific URL; input: an https URL.\n' +
  'rugcheck — on-chain analysis of a SOLANA TOKEN MINT via RugCheck: risk score, mint/freeze authority (null=renounced), top-holder concentration + insider flags, INSIDER CLUSTER count (graphInsidersDetected/insiderNetworks), LP lock, liquidity, holder count. Input: a Solana mint address. Use this for any token rug/cluster/holder-concentration question — do NOT scrape explorer pages for this.\n' +
  'trending — LIVE trending tokens, newest launches ("trenches"), and paid-promoted tokens on a chain (default Solana) via GeckoTerminal + DexScreener: names, price, 1h/24h change, 24h volume, FDV, age, and a pump.fun flag. This is the AUTHORITATIVE source for "what is the current meta / what is trending / what is hot / pump.fun trenches" questions — always prefer it over web search/CoinMarketCap/CoinGecko, which are stale and high-level. Input: a chain name (default "solana").';

async function plan(question) {
  const prompt =
`You are Sebastian Hunter's research planner. Draft an explicit plan to answer the QUESTION using ONLY these tools:
${TOOL_DESCR}

QUESTION: ${question}

First EVALUATE what kind of question this is and which source can actually answer it — do not default to generic web search. Match the question to the right instrument:
- "current meta / what's trending / hot tokens / pump.fun or Solana trenches / newest launches" → use the 'trending' tool (live trending + new-launch + promoted tokens). This is primary; name specific tokens, their price action and age from it. You may ALSO 'fetch' canonical live pages for corroboration/detail: https://dexscreener.com/solana?rankBy=trendingScoreH6&order=desc , https://www.geckoterminal.com/solana/pools , https://pump.fun/board . Do NOT rely on CoinMarketCap/CoinGecko/Discord landing pages for live meta — they are stale.
- "sentiment / what are traders saying / why is <token> trending / community mood" → 'xsearch' (LIVE X search) with the token/cashtag or topic. This is the source for real-time discourse; do NOT use web 'search' with site:x.com.
- "is <token> a rug / holder clusters / who holds it" → 'rugcheck' with the mint address (mints come from 'trending' output).
- factual claim / who/what/when → recall + posts for what's known, then 'search' and 'fetch' the most authoritative primary source.

Sequence generally: start from what's known (recall/posts), pull LIVE structured data (trending/rugcheck) when the question is about markets/tokens, then search+fetch to corroborate and add detail. For 'fetch' steps you may construct KNOWN canonical URLs directly; URLs discovered by 'search' are fetched in a later adaptive step, so you don't need to guess those.

Output ONLY JSON (no fences):
{
  "goal": "restate what a good answer must establish",
  "approach": "1-2 sentence strategy — name which instrument answers this and why",
  "steps": [ {"tool":"recall|posts|xsearch|search|fetch|rugcheck|trending","input":"the query, URL, mint, or chain","rationale":"why this step"} ],
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

// Critic pass: look at what's been gathered and propose follow-up tool steps that
// would ANSWER the still-open, researchable sub-questions (the whole point — an
// "open question" that a tool could resolve is a gap to close, not a caveat to
// print). Returns [] when nothing further is worth chasing.
async function gapSteps(question, plan, findings) {
  const dossier = findings.map((f) => `### ${f.tool}: ${f.input}\n${String(f.result).slice(0, 1200)}`).join('\n\n');
  const prompt =
`You are Sebastian Hunter's research critic. Decide what is STILL worth researching.

QUESTION: ${question}

TOOLS AVAILABLE:
${TOOL_DESCR}

WHAT WE'VE GATHERED SO FAR:
${dossier}

List the sub-questions that are (a) not yet answered by the dossier AND (b) actually answerable with the tools above — then give the concrete steps to answer them. Examples of researchable "open questions": WHY a token is trending (search X / posts for the driver), whether a narrative (e.g. "AI agents") is present (trending/posts), a token's on-chain safety (rugcheck its mint), survivability/age stats (trending data), who a named figure is (search). Do NOT propose steps for things the dossier already answers, or that no tool can resolve. Be surgical — max 5 highest-value steps.

Output ONLY JSON (no fences):
{"remaining_gaps":["..."],"steps":[{"tool":"recall|posts|xsearch|search|fetch|rugcheck|trending","input":"the query, URL, mint, or chain","rationale":"which gap this closes"}]}
Return an empty steps array if the question is already well answered.`;
  const raw = await reason(prompt, { maxTokens: 900, tag: 'dr-gap' });
  try {
    const j = JSON.parse(String(raw).replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/)[0]);
    return Array.isArray(j.steps) ? j.steps.filter((s) => s && TOOLS[s.tool]).slice(0, 5) : [];
  } catch { return []; }
}

async function synthesize(question, plan, findings) {
  const dossier = findings.map((f) => `### ${f.tool}: ${f.input}\n${f.result}`).join('\n\n');
  const prompt =
`You are Sebastian Hunter. Answer the QUESTION using ONLY the RESEARCH DOSSIER below (do not invent facts). Be specific, cite the source (tool + URL) for each claim, state a confidence level (high/medium/low).

QUESTION: ${question}

SUCCESS CRITERIA: ${plan.success_criteria || '(none)'}
CAVEATS TO CHECK: ${plan.caveats || '(none)'}

RESEARCH DOSSIER:
${dossier}

Write a concise findings report: the answer (or best-supported hypothesis), the evidence with citations, and confidence. You MAY include an "Open questions" section, but ONLY for things that genuinely could not be resolved with the available data — NOT for gaps you simply didn't pursue. If the dossier contains the answer to a sub-question, answer it; do not relist it as open.`;
  return reason(prompt, { maxTokens: 1800, tag: 'dr-synth' });
}

// ── Flat path (trivial/standard tiers): plan → execute → refine → synthesize ──
async function flatResearch(question, { maxFetch = 4, maxRounds = 2 } = {}) {
  const p = await plan(question);
  log(`plan: ${(p.steps || []).length} step(s) — ${p.approach || ''}`);
  const { findings, discoveredUrls } = await execute(p.steps || []);
  const fetched = await adaptiveFetch(question, findings, discoveredUrls, maxFetch);
  let all = [...findings, ...fetched];
  for (let round = 1; round <= maxRounds; round++) {
    const gaps = await gapSteps(question, p, all);
    if (!gaps.length) { log(`refine: no researchable gaps left (round ${round})`); break; }
    log(`refine round ${round}: ${gaps.length} follow-up step(s) — ${gaps.map((g) => g.tool).join(', ')}`);
    const gr = await execute(gaps);
    const gf = await adaptiveFetch(question, gr.findings, gr.discoveredUrls, Math.max(2, maxFetch - 1));
    all = [...all, ...gr.findings, ...gf];
  }
  const report = await synthesize(question, p, all);
  return { plan: p, findings: all, report };
}

// ══ Hierarchical decomposition engine (deep tier) ═════════════════════════════
// analyze → decompose (≤3 levels) → review the whole checklist → run in logical
// order → update a living doc (JSON + Markdown) → synthesize from the tree.
// See docs/deep-research-decomposition.md.

const JOBS_DIR = path.join(ROOT, 'state', 'research_jobs');
const cleanJson = (raw) => { const m = String(raw).replace(/```(?:json)?/gi, '').match(/[[{][\s\S]*[}\]]/); return m ? JSON.parse(m[0]) : null; };

// Cheap complexity gate. trivial|standard → flat path; deep → tree path.
async function classify(question) {
  const prompt =
`Classify this research request's complexity for planning.
QUESTION: ${question}
- "trivial": one factual lookup / yes-no / single entity (e.g. "is X true?", "who owns wallet W?").
- "standard": one topic, a few angles, no real sub-structure.
- "deep": multi-part, a broad "state of / landscape / current meta", an explicit "deep research", or anything that clearly benefits from being broken into sub-questions.
Output ONLY JSON: {"tier":"trivial|standard|deep","why":"short"}`;
  try { const j = cleanJson(await reason(prompt, { maxTokens: 150, tag: 'dr-classify' })); return (j && j.tier) || 'standard'; }
  catch { return 'standard'; }
}

// Give every node an id (1, 1.1, 1.2.3…), enforce depth + node caps, init state.
function normalizeTree(root, maxDepth, maxNodes) {
  const state = { n: 0 };
  const walk = (node, depth, id) => {
    if (!node || typeof node !== 'object') return null;
    if (state.n >= maxNodes) return null;
    state.n++;
    node.id = id;
    node.status = 'pending';
    node.findings = [];
    node.answer = null;
    node.research_areas = Array.isArray(node.research_areas) ? node.research_areas : [];
    node.tools_hint = (Array.isArray(node.tools_hint) ? node.tools_hint : []).filter((t) => TOOLS[t]);
    node.depends_on = Array.isArray(node.depends_on) ? node.depends_on : [];
    let kids = Array.isArray(node.children) ? node.children : [];
    if (depth >= maxDepth) kids = [];              // enforce ≤ maxDepth levels
    node.children = kids.map((k, i) => walk(k, depth + 1, `${id}.${i + 1}`)).filter(Boolean);
    return node;
  };
  return walk(root, 1, '1');
}

async function decompose(question, { maxDepth = 3, maxNodes = 24 } = {}) {
  const prompt =
`You are Sebastian Hunter's research architect. Break the QUESTION into a research TREE.
QUESTION: ${question}

TOOLS available at the leaves:
${TOOL_DESCR}

Rules:
- Nest UP TO ${maxDepth} levels — but only split a node when its parts are genuinely separable. Prefer 3-6 top-level parts.
- A LEAF (no children) must be answerable by a short sequence of the tools above.
- ${maxNodes} nodes max total.
- Every node has: title, question (standalone), direction (how to approach it), research_areas (angles/sources to consider), tools_hint (subset of tool names likely to help), success_criterion (what evidence would resolve it), depends_on (titles of earlier nodes whose answers this needs first, or []).

Output ONLY JSON (no fences), the root node:
{"title":"..","question":"..","direction":"..","research_areas":[..],"tools_hint":[..],"success_criterion":"..","depends_on":[],"children":[ ..same shape.. ]}`;
  const root = cleanJson(await reason(prompt, { maxTokens: 2600, tag: 'dr-decompose' }));
  if (!root) throw new Error('decompose: no JSON tree returned');
  return normalizeTree(root, maxDepth, maxNodes);
}

function flattenNodes(node, out = []) { if (!node) return out; out.push(node); (node.children || []).forEach((c) => flattenNodes(c, out)); return out; }
function findNode(root, id) { return flattenNodes(root).find((n) => n.id === id) || null; }
function renderOutline(root) {
  return flattenNodes(root).map((n) => `${'  '.repeat(n.id.split('.').length - 1)}- [${n.id}] ${n.title} — resolves when: ${n.success_criterion || '?'}${n.depends_on.length ? ` (needs: ${n.depends_on.join(', ')})` : ''}`).join('\n');
}

// The "second check": critique the whole checklist before execution, revise once.
async function reviewPlan(question, root) {
  const prompt =
`Review this research PLAN before any execution.
QUESTION: ${question}
TOOLS: ${TOOL_DESCR}

PLAN:
${renderOutline(root)}

Check for: (a) missing angles/gaps, (b) redundant or overlapping nodes, (c) leaves NO tool can resolve, (d) wrong dependency order.
Output ONLY JSON:
{"add":[{"parent_id":"<id or root>","title":"..","question":"..","direction":"..","research_areas":[..],"tools_hint":[..],"success_criterion":"..","depends_on":[]}],"drop_ids":["<id>"],"mark_unresolvable_ids":["<id>"],"notes":".."}
Return empty arrays if the plan is already sound.`;
  let rev; try { rev = cleanJson(await reason(prompt, { maxTokens: 1200, tag: 'dr-review' })); } catch { rev = null; }
  if (!rev) return root;
  for (const id of (rev.drop_ids || [])) { const p = flattenNodes(root).find((n) => (n.children || []).some((c) => c.id === id)); if (p) p.children = p.children.filter((c) => c.id !== id); }
  for (const id of (rev.mark_unresolvable_ids || [])) { const n = findNode(root, id); if (n) n.status = 'unresolvable'; }
  for (const a of (rev.add || [])) {
    const parent = findNode(root, a.parent_id) || root;
    const child = normalizeTree({ ...a, children: [] }, 3, 999);
    child.id = `${parent.id}.${(parent.children || []).length + 1}`;
    parent.children = parent.children || []; parent.children.push(child);
  }
  if (rev.notes) log(`review: ${String(rev.notes).slice(0, 120)}`);
  return root;
}

// Order a node's children by depends_on (title references); stable fallback.
function orderByDeps(children) {
  const byTitle = new Map(children.map((c) => [c.title, c]));
  const done = new Set(), out = [];
  const visit = (c, stack = new Set()) => {
    if (done.has(c.id) || stack.has(c.id)) return; stack.add(c.id);
    for (const dep of (c.depends_on || [])) { const d = byTitle.get(dep); if (d && d !== c) visit(d, stack); }
    if (!done.has(c.id)) { done.add(c.id); out.push(c); }
  };
  children.forEach((c) => visit(c));
  return out;
}

// Generate concrete tool steps for a leaf, given its direction + tool hints.
async function leafSteps(node) {
  const prompt =
`Produce up to 4 concrete tool steps to answer this research bit.
QUESTION: ${node.question}
DIRECTION: ${node.direction || ''}
SUGGESTED TOOLS: ${(node.tools_hint || []).join(', ') || '(any)'}
RESOLVES WHEN: ${node.success_criterion || ''}
TOOLS: ${TOOL_DESCR}
Output ONLY JSON: {"steps":[{"tool":"recall|posts|xsearch|search|fetch|rugcheck|trending","input":"..","rationale":".."}]}`;
  try {
    const j = cleanJson(await reason(prompt, { maxTokens: 700, tag: 'dr-leaf' }));
    return (j && Array.isArray(j.steps) ? j.steps : [])
      // Drop steps whose input is a planning placeholder (e.g. "<mint_address_of_top_candidate>")
      // — those values only exist after earlier tools run; the runtime-refinement
      // round below re-issues them with the real values.
      .filter((s) => s && TOOLS[s.tool] && !/<[^>]+>|\bTBD\b|placeholder|mint_address|_(of|for)_|top.?candidate/i.test(String(s.input || '')))
      .slice(0, 4);
  } catch { return []; }
}

// Short answer for one node from its own findings (+ children answers).
async function answerNode(node, childAnswers) {
  const dossier = node.findings.map((f) => `### ${f.tool}: ${f.input}\n${String(f.result).slice(0, 1400)}`).join('\n\n');
  const kids = childAnswers.filter(Boolean).map((c) => `- ${c.title}: ${c.answer}`).join('\n');
  const prompt =
`Answer this ONE research sub-question from the evidence only (no invention). 2-4 sentences, specific, cite tool/URL, note confidence.
SUB-QUESTION: ${node.question}
${kids ? `SUB-FINDINGS:\n${kids}\n` : ''}${dossier ? `EVIDENCE:\n${dossier}` : '(no direct evidence gathered)'}`;
  try { return String(await reason(prompt, { maxTokens: 400, tag: 'dr-node' })).trim(); }
  catch { return null; }
}

// Post-order execution: resolve children first, leaves run tools. v1 is
// sequential (concurrency=1); step 2 flips this to bounded parallel workers.
async function researchNode(node, root, job, persist, maxFetch) {
  if (node.status === 'unresolvable') { await persist(); return node; }
  node.status = 'running'; await persist();
  const orderedKids = orderByDeps(node.children || []);
  const childAnswers = [];
  for (const kid of orderedKids) { await researchNode(kid, root, job, persist, maxFetch); childAnswers.push(kid); }

  if (!node.children || node.children.length === 0) {   // LEAF → run tools
    const steps = await leafSteps(node);
    log(`  [${node.id}] ${node.title}: ${steps.length} step(s)`);
    const { findings, discoveredUrls } = await execute(steps);
    const fetched = await adaptiveFetch(node.question, findings, discoveredUrls, Math.min(2, maxFetch));
    node.findings = [...findings, ...fetched];
    // Runtime refinement: now that real data exists (e.g. mints surfaced by
    // 'trending', URLs by 'search'), issue the follow-ups that needed those
    // concrete values — this is what closes data-dependent steps like rugcheck.
    const follow = await gapSteps(node.question, { success_criteria: node.success_criterion }, node.findings);
    if (follow.length) {
      log(`  [${node.id}] refine: ${follow.length} follow-up step(s) — ${follow.map((s) => s.tool).join(', ')}`);
      const fr = await execute(follow.slice(0, 3));
      const ff = await adaptiveFetch(node.question, fr.findings, fr.discoveredUrls, 1);
      node.findings = [...node.findings, ...fr.findings, ...ff];
    }
  }
  node.answer = await answerNode(node, childAnswers);
  node.status = node.answer ? 'answered' : 'unresolvable';
  await persist();
  return node;
}

function renderMarkdown(job) {
  const mark = { pending: '[ ]', running: '[~]', answered: '[x]', unresolvable: '[!]' };
  const lines = [`# Research: ${job.question}`, ``, `tier: ${job.tier} · status: ${job.status} · nodes: ${flattenNodes(job.root).length}`, ``];
  for (const n of flattenNodes(job.root)) {
    const indent = '  '.repeat(n.id.split('.').length - 1);
    lines.push(`${indent}- ${mark[n.status] || '[ ]'} **${n.title}**`);
    if (n.answer) lines.push(`${indent}  ${String(n.answer).replace(/\n+/g, ' ').slice(0, 300)}`);
  }
  return lines.join('\n');
}

async function treeResearch(question, { maxFetch = 3, maxDepth = 3, maxNodes = 24 } = {}) {
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
  const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${question.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
  const job = { job_id: jobId, question, tier: 'deep', status: 'planning', root: null };
  const persist = async () => {
    try {
      fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(job, null, 2));
      if (job.root) fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.md`), renderMarkdown(job));
    } catch (e) { log(`persist failed (non-fatal): ${e.message}`); }
  };

  log(`decomposing (deep tier)…`);
  job.root = await decompose(question, { maxDepth, maxNodes });
  job.status = 'reviewing'; await persist();
  job.root = await reviewPlan(question, job.root);
  log(`plan: ${flattenNodes(job.root).length} node(s) after review`);
  job.status = 'running'; await persist();

  await researchNode(job.root, job.root, job, persist, maxFetch);

  const allFindings = flattenNodes(job.root).flatMap((n) => n.findings || []);
  const report = await synthesizeTree(question, job.root);
  job.status = 'done'; await persist();
  log(`done → ${path.join(JOBS_DIR, jobId + '.md')}`);
  return { job, plan: job.root, findings: allFindings, report };
}

// Assemble the report from the resolved tree (structure already established).
async function synthesizeTree(question, root) {
  const outline = flattenNodes(root).map((n) => {
    const indent = '  '.repeat(n.id.split('.').length - 1);
    return `${indent}## ${n.title}\n${indent}${n.answer || '(unresolved)'}`;
  }).join('\n\n');
  const prompt =
`You are Sebastian Hunter. Write the final research report for the QUESTION from the RESOLVED RESEARCH TREE below (answers already established per sub-question — do not invent beyond them). Organize logically, keep the concrete specifics/citations, give an overall confidence, and an "Open questions" section ONLY for genuinely unresolvable items.

QUESTION: ${question}

RESOLVED TREE:
${outline}`;
  return reason(prompt, { maxTokens: 2200, tag: 'dr-synth-tree' });
}

async function deepResearch(question, { maxFetch = 4, planOnly = false, maxRounds = 2, tier: forcedTier, allowTree = true } = {}) {
  log(`question: ${question}`);
  if (planOnly) return { plan: await plan(question) };
  let tier = forcedTier || await classify(question);
  // Gate: the deep tree tier is multi-minute + many-call. Callers that run inline
  // in a latency-sensitive path (X mention auto-reply) pass allowTree=false, which
  // downgrades deep→standard so they stay on the fast flat path.
  if (tier === 'deep' && !allowTree) { log('tier: deep → standard (tree gated off for this caller)'); tier = 'standard'; }
  log(`tier: ${tier}`);
  if (tier === 'deep') return treeResearch(question, { maxFetch: Math.min(3, maxFetch) });
  return flatResearch(question, { maxFetch, maxRounds });
}

/** Turn research findings into publishable report blocks (with rug-check viz). */
function findingsToBlocks(question, report, findings, shortAnswer) {
  const blocks = [{ type: 'callout', tone: 'info', title: 'Answer:', text: shortAnswer || 'See analysis below.' }];
  // Rich rug-check viz when a rugcheck finding is present.
  const rc = findings.find((f) => f.tool === 'rugcheck');
  let kind = 'research';
  if (rc) {
    try {
      const d = JSON.parse(rc.result);
      kind = 'rug_check';
      blocks.push({ type: 'keyvalue', items: [
        { k: 'RugCheck score', v: `${d.score_normalised ?? '?'} / 10` },
        { k: 'Rugged', v: d.rugged ? 'YES ⚠' : 'no' },
        { k: 'Mint authority', v: d.mintAuthorityRenounced ? 'renounced ✓' : 'ACTIVE ⚠' },
        { k: 'Freeze authority', v: d.freezeAuthorityRenounced ? 'renounced ✓' : 'ACTIVE ⚠' },
        { k: 'Liquidity', v: d.totalMarketLiquidity != null ? `$${Math.round(d.totalMarketLiquidity).toLocaleString()}` : '?' },
        { k: 'LP providers', v: d.totalLPProviders ?? '?' },
        { k: 'Insider clusters', v: d.graphInsidersDetected ?? (d.insiderNetworks ? d.insiderNetworks.length : '?') },
      ] });
      const th = (d.topHolders || []).slice(0, 10).map((h) => { const m = String(h).match(/([\d.]+)%/); return { label: String(h).replace(/\s*[\d.]+%.*/, '') || 'holder', value: m ? +m[1] : 0 }; }).filter((x) => x.value);
      if (th.length) blocks.push({ type: 'bar_chart', title: 'Top holders (% of supply)', data: th });
    } catch { /* fall through to text */ }
  }
  blocks.push({ type: 'markdown', md: report });
  const sources = findings.filter((f) => f.tool === 'fetch' && /^https?:\/\//.test(f.input)).map((f) => ({ url: f.input }));
  if (sources.length) blocks.push({ type: 'sources', items: sources.slice(0, 8) });
  return { blocks, kind };
}

/**
 * researchAndPublish(question) — run deep research, publish a report page, and
 * return a short X-length answer + the report URL. Used by the autonomous X
 * reply path so a mention that asks a question gets a real answer + a link to
 * the full, visualized breakdown.
 */
async function researchAndPublish(question, { maxFetch = 3, publish = true, source = 'x_mention' } = {}) {
  // Gate the slow deep-tree tier off the inline X-mention path unless explicitly
  // opted in (X_DEEP_TREE=1). Other callers (e.g. Telegram /dr) allow the tree.
  const allowTree = source !== 'x_mention' || process.env.X_DEEP_TREE === '1';
  const { findings, report } = await deepResearch(question, { maxFetch, allowTree });
  const shortAnswer = await reason(
    `Given this research, write ONE X reply (max 240 chars) that directly answers the question in Sebastian Hunter's voice — specific, name the key finding, no hedging, no "I think". Question: ${question}\n\nResearch report:\n${report.slice(0, 2500)}\n\nReply text only (no quotes):`,
    { maxTokens: 200, tag: 'dr-reply' }
  ).then((t) => String(t).trim().replace(/^["']|["']$/g, '')).catch(() => '');
  let url = null;
  if (publish) {
    try {
      const { publishReport } = require('./publish_report');
      const { blocks, kind } = findingsToBlocks(question, report, findings, shortAnswer);
      url = await publishReport({ title: question.slice(0, 120), summary: shortAnswer, kind, source, blocks });
    } catch (e) { log(`publish failed: ${e.message}`); }
  }
  return { shortAnswer, url, report, findings };
}

module.exports = { deepResearch, researchAndPublish, plan, TOOLS, classify, decompose, reviewPlan, treeResearch, flatResearch };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const planOnly = args.includes('--plan-only');
    const mf = (args.find((a) => a.startsWith('--max-fetch=')) || '').split('=')[1];
    const forcedTier = (args.find((a) => a.startsWith('--tier=')) || '').split('=')[1];   // trivial|standard|deep
    const question = args.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!question) { console.error('usage: node runner/deep_research.js "<question>" [--plan-only] [--tier=deep] [--max-fetch=N]'); process.exit(2); }
    try {
      const res = await deepResearch(question, { planOnly, tier: forcedTier || undefined, maxFetch: mf ? Number(mf) : 4 });
      if (planOnly) { console.log('\n=== PLAN ===\n' + JSON.stringify(res.plan, null, 2)); }
      else { console.log('\n=== REPORT ===\n' + res.report); }
      process.exit(0);
    } catch (e) { console.error(`[deep_research] failed: ${e.message}`); process.exit(1); }
  })();
}
