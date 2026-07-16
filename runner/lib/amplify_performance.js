'use strict';
/**
 * runner/lib/amplify_performance.js — the "test and learn" loop for AMPLIFICATION
 * (X reposts/quotes, LinkedIn reshares). Same shape as lib/linkedin_performance.js
 * and the prediction-calibration loop, but the arm being optimized is *which
 * source/topic is worth amplifying* rather than how a post opens.
 *
 * Flow (mirrors the posting loop):
 *   recordAmplification(ourUrl, {...})  tag an amplification we just published
 *   recordMetric(ourUrl, {reactions,comments})  store the engagement it earned
 *   unmeasured({hours})                 amplifications old enough to measure
 *   sourceStats() / topicStats()        per-source / per-topic averages
 *   pickAmplifyTarget(candidates)       choose what to amplify (explore/exploit)
 *   summaryText()                       track-record string for prompts/logs
 *
 * The optimized metric is ENGAGEMENT = reactions + comments (same as posting).
 * "Reactions/comments" are the amplification's OWN engagement where the channel
 * exposes it (X quote, LinkedIn reshare-with-commentary); a bare repost/reshare
 * that carries no own-post counter is still tagged and can be measured later by
 * proxy (e.g. profile-level lift) — the store shape doesn't assume a source.
 *
 * Pure JS, file-backed, unit-testable. No network.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const STORE = path.join(config.STATE_DIR, 'amplify_metrics.json');
const MIN_SAMPLES = Number(process.env.AMPLIFY_MIN_SAMPLES) || 2;  // force-explore a source until it has this many measured amplifications
const EPS = Number(process.env.AMPLIFY_EPSILON) || 0.3;           // explore probability once warmed up

// Amplification techniques (a secondary dimension, reported not optimized here).
const TECHNIQUES = ['repost', 'quote', 'reshare'];

const normHandle = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();
const _rand = () => Math.random();

function load() {
  try { const j = JSON.parse(fs.readFileSync(STORE, 'utf-8')); return { items: j.items || {} }; }
  catch { return { items: {} }; }
}
function save(store) { try { fs.writeFileSync(STORE, JSON.stringify(store, null, 2)); } catch {} }

/**
 * Tag a freshly-published amplification (engagement filled in later by measure).
 * @param {string} ourUrl   the URL of OUR repost/quote/reshare (identity)
 * @param {object} meta
 * @param {string} meta.channel        'x' | 'linkedin'
 * @param {string} meta.sourceHandle   the amplified author's handle (no @)
 * @param {string} [meta.topic]        coarse topic/axis label
 * @param {string} [meta.technique]    'repost' | 'quote' | 'reshare'
 * @param {string} [meta.sourceUrl]    the amplified post's URL
 * @param {string} [meta.postedAt]     ISO; defaults to now
 * @param {boolean} [meta.measurable]  false for a bare repost/reshare that carries
 *   no own engagement surface — it is still tagged (so we have a record of WHAT we
 *   amplified) but excluded from the measure queue so it never blocks it. Default true.
 */
function recordAmplification(ourUrl, { channel, sourceHandle, topic = null, technique = null, sourceUrl = null, postedAt, measurable = true } = {}) {
  if (!ourUrl || !channel) return;
  const s = load();
  const prev = s.items[ourUrl] || {};
  s.items[ourUrl] = {
    ...prev,
    channel,
    source_handle: normHandle(sourceHandle),
    topic: topic || prev.topic || null,
    technique: technique || prev.technique || null,
    source_url: sourceUrl || prev.source_url || null,
    measurable: measurable !== false,
    posted_at: postedAt || prev.posted_at || new Date().toISOString(),
  };
  save(s);
}

/** Store scraped engagement for one of our amplifications. engagement = reactions + comments. */
function recordMetric(ourUrl, { reactions = 0, comments = 0 } = {}) {
  const s = load();
  const prev = s.items[ourUrl] || {};
  s.items[ourUrl] = { ...prev, reactions, comments, engagement: (reactions || 0) + (comments || 0), measured_at: new Date().toISOString() };
  save(s);
}

/** Amplifications old enough to have accrued engagement but not yet measured. */
function unmeasured({ olderThanHours = 24, staleAfterHours = 72 } = {}) {
  const s = load();
  const now = Date.now();
  const out = [];
  for (const [url, p] of Object.entries(s.items)) {
    if (p.measurable === false) continue;   // bare repost/reshare: no own engagement surface
    const age = p.posted_at ? (now - Date.parse(p.posted_at)) / 3600000 : 0;
    if (age < olderThanHours) continue;
    const measuredAge = p.measured_at ? (now - Date.parse(p.measured_at)) / 3600000 : Infinity;
    if (p.engagement != null && (measuredAge < staleAfterHours || age > staleAfterHours * 2)) continue;
    out.push({ url, channel: p.channel, source_handle: p.source_handle, technique: p.technique, posted_at: p.posted_at });
  }
  return out;
}

/** Generic per-key averages over MEASURED amplifications. keyFn maps an item → bucket key (or null to skip). */
function _statsBy(keyFn) {
  const s = load();
  const acc = {};
  for (const p of Object.values(s.items)) {
    if (p.engagement == null) continue;
    const k = keyFn(p);
    if (!k) continue;
    const a = acc[k] || (acc[k] = { key: k, n: 0, reactions: 0, comments: 0, engagement: 0 });
    a.n++; a.reactions += p.reactions || 0; a.comments += p.comments || 0; a.engagement += p.engagement || 0;
  }
  for (const k of Object.keys(acc)) {
    const a = acc[k];
    a.avgEng = a.n ? +(a.engagement / a.n).toFixed(1) : null;
    a.avgReactions = a.n ? +(a.reactions / a.n).toFixed(1) : null;
    a.avgComments = a.n ? +(a.comments / a.n).toFixed(1) : null;
  }
  return acc;
}

const sourceStats = () => _statsBy((p) => p.source_handle || null);
const topicStats = () => _statsBy((p) => p.topic || null);

/** Learned average engagement for a source handle, or null if never measured. */
function sourceValue(handle) {
  const a = sourceStats()[normHandle(handle)];
  return a && a.n ? a.avgEng : null;
}

/**
 * Choose which candidate to amplify this cycle (explore/exploit on learned source
 * value). Candidates that reference an UNSEEN source (< MIN_SAMPLES measured
 * amplifications) are force-explored first — deterministic least-sampled-first —
 * so every source earns a track record before exploitation. Once warmed up:
 * epsilon-greedy on avg engagement.
 *
 * @param {Array<{sourceHandle:string, [topic]:string, ...}>} candidates
 * @param {object} [opts]  {epsilon, minSamples, rand} (rand injectable for tests)
 * @returns {{candidate:object, reason:string}|null}
 */
function pickAmplifyTarget(candidates, { epsilon = EPS, minSamples = MIN_SAMPLES, rand = _rand } = {}) {
  const list = (candidates || []).filter((c) => c && c.sourceHandle);
  if (!list.length) return null;
  const stats = sourceStats();
  const nOf = (c) => (stats[normHandle(c.sourceHandle)] || { n: 0 }).n;
  const engOf = (c) => { const a = stats[normHandle(c.sourceHandle)]; return a && a.n ? a.avgEng : null; };

  // Force-explore under-sampled sources, least-sampled first.
  const under = list.filter((c) => nOf(c) < minSamples);
  if (under.length) {
    under.sort((a, b) => nOf(a) - nOf(b));
    return { candidate: under[0], reason: `explore:under_sampled(n=${nOf(under[0])})` };
  }
  // Epsilon-explore: random candidate.
  if (rand() < epsilon) {
    return { candidate: list[Math.floor(rand() * list.length)], reason: 'explore:epsilon' };
  }
  // Exploit: highest learned source value.
  let best = list[0];
  for (const c of list) if ((engOf(c) ?? -1) > (engOf(best) ?? -1)) best = c;
  return { candidate: best, reason: `exploit:avgEng=${engOf(best)}` };
}

/** Track-record paragraph (top sources by avg engagement) for prompts / operator logs. */
function summaryText({ topN = 6 } = {}) {
  const stats = sourceStats();
  const rows = Object.values(stats).filter((a) => a.n > 0).sort((a, b) => (b.avgEng ?? -1) - (a.avgEng ?? -1)).slice(0, topN);
  if (!rows.length) return '';
  const lines = rows.map((a) => `  • @${a.key}: avg ${a.avgEng} engagement (${a.avgReactions} reactions + ${a.avgComments} comments) over ${a.n} amplification(s)`).join('\n');
  return `AMPLIFICATION TRACK RECORD (engagement = reactions + comments), by source — measured, not guessed:\n${lines}\n` +
    `Best so far: @${rows[0].key}. Bias amplification toward sources that actually earn engagement.`;
}

module.exports = {
  TECHNIQUES, recordAmplification, recordMetric, unmeasured,
  sourceStats, topicStats, sourceValue, pickAmplifyTarget, summaryText,
};
