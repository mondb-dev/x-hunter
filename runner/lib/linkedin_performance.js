'use strict';
/**
 * runner/lib/linkedin_performance.js — the "test and learn" loop for Sebastian's
 * LinkedIn posting. Each post is tagged with its SHAPE (opening technique,
 * ending type, length bucket, media); engagement (reactions + comments) is
 * measured after it accrues; the per-dimension engagement profile is fed back
 * into the draft prompt and biases shape selection (explore/exploit). Every
 * post contributes a sample to ALL dimensions at once, so the loop warms up in
 * a handful of posts despite testing four variables. Same mechanism as the
 * prediction-calibration loop.
 *
 *   pickShape()          -> per-dimension assignment for the next post (force-explore + epsilon-greedy)
 *   pickTechnique()      -> technique-only pick (fallback template path)
 *   summaryText()        -> track-record string for the draft/plan prompt
 *   recordPost(url,shape)-> tag a freshly-posted URL with its shape ({technique, ending, length, media, topic}; a bare string is treated as {technique})
 *   recordMetric(url,m)  -> store scraped {reactions,comments,reposts,impressions} for a URL
 *   unmeasured({hours})  -> posts old enough to measure but not yet measured
 *   dimensionStats()     -> {dim: {value: {n, avgScore}}}   (assigned dims)
 *   observedStats()      -> {time, day, topic}              (context dims — recorded, never assigned)
 *   lengthBucket(words)  -> 'short' | 'medium' | 'long'
 *
 * METRIC ("effective"): weighted engagement = reactions + 2×comments + 3×reposts
 * (weights env-tunable: LI_W_REACTION/COMMENT/REPOST — a repost extends reach,
 * a comment costs real effort, a reaction is cheap), measured PER 100 IMPRESSIONS
 * when reach was scraped (own posts expose an impressions line) so a post seen by
 * 40 people and one by 4,000 compare fairly. Before this biases selection,
 * scoreDimensions() applies two small-sample corrections — shrinkage toward a
 * baseline (SHRINK_K) and confound control via context-bucket residuals (see its
 * docstring). A post scores only once reach is known (impressions > 0). Pure JS.
 *
 * CONTEXT, NOT LEVERS: posting time (Asia/Manila bucket), weekday/weekend, and
 * a coarse topic slug are recorded per post and reported in summaryText() so
 * "what works when / about what" accumulates — but pickShape() never assigns
 * them; they describe conditions, they aren't part of the experiment.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const STORE = path.join(config.STATE_DIR, 'linkedin_post_metrics.json');
const MIN_SAMPLES = Number(process.env.LI_LEARN_MIN_SAMPLES) || 2;   // force-explore until each value has this many measured posts
const EPS = Number(process.env.LI_LEARN_EPSILON) || 0.3;             // explore probability once warmed up
const SHRINK_K = Number(process.env.LI_LEARN_SHRINK_K) || 200;       // prior "pseudo-impressions" pulling a post's rate toward its baseline
const MIN_CONTEXT = Number(process.env.LI_LEARN_MIN_CONTEXT) || 4;   // posts a context bucket needs before it overrides the global baseline
const CONTEXT_DIM = process.env.LI_LEARN_CONTEXT || 'day';           // observed dim used as the confound baseline (day/time/topic); day is densest

// Engagement weights (see METRIC above).
const W = {
  reaction: Number(process.env.LI_W_REACTION) || 1,
  comment:  Number(process.env.LI_W_COMMENT)  || 2,
  repost:   Number(process.env.LI_W_REPOST)   || 3,
};

/** The A/B score of a measured post: rate per 100 impressions when reach is
 *  known, raw weighted engagement otherwise. null = not measured yet. */
function postScore(p) {
  if (p.engagement == null) return null;
  return p.rate != null ? p.rate : p.engagement;
}

const MANILA_OFFSET_H = 8; // Sebastian posts on Manila time
function timeBucket(iso) {
  const h = (new Date(iso).getUTCHours() + MANILA_OFFSET_H) % 24;
  return h < 6 ? 'night' : h < 11 ? 'morning' : h < 14 ? 'midday' : h < 18 ? 'afternoon' : 'evening';
}
function dayBucket(iso) {
  const d = new Date(Date.parse(iso) + MANILA_OFFSET_H * 3600e3).getUTCDay();
  return d === 0 || d === 6 ? 'weekend' : 'weekday';
}

// The shape dimensions Sebastian A/B-tests. Small, distinct value sets so each
// accrues enough samples to compare; one post samples every dimension.
const DIMENSIONS = {
  technique: ['question_hook', 'stat_hook', 'contrarian_hook', 'scene_hook'],
  ending:    ['question', 'claim', 'implication'],
  length:    ['short', 'medium', 'long'],          // see lengthBucket()
  media:     ['none', 'image', 'link'],
};

const LENGTH_WORDS = { short: [100, 150], medium: [150, 250], long: [250, 350] };

function lengthBucket(words) {
  return words < 150 ? 'short' : words <= 250 ? 'medium' : 'long';
}

// The variable Sebastian A/B-tests: how a LinkedIn post OPENS. Kept to a small,
// distinct set so each accrues enough samples to compare.
const TECHNIQUES = [
  { id: 'question_hook',   label: 'open with a sharp question',   instruction: 'OPEN with a single sharp, specific question that names the real tension — no preamble, no "Have you ever". The question must be concrete to this topic.' },
  { id: 'stat_hook',       label: 'open with a concrete number',  instruction: 'OPEN with a specific, verifiable number or fact from the source material, then unpack what it actually reveals.' },
  { id: 'contrarian_hook', label: 'open contrarian',              instruction: 'OPEN by stating the conventional reading in one line, then flip it — the non-obvious interpretation the evidence actually supports.' },
  { id: 'scene_hook',      label: 'open with a concrete scene',   instruction: 'OPEN with one concrete, current example — name the actor, the event, the specific moment — then move from that instance to the systemic pattern.' },
];

const byId = (id) => TECHNIQUES.find((t) => t.id === id) || null;

function load() {
  try { const j = JSON.parse(fs.readFileSync(STORE, 'utf-8')); return { posts: j.posts || {} }; }
  catch { return { posts: {} }; }
}
function save(store) { try { fs.writeFileSync(STORE, JSON.stringify(store, null, 2)); } catch {} }

/** Tag a freshly-posted URL with its shape (engagement filled in later).
 *  shape: {technique, ending, length, media, topic} — unknown/missing dims are
 *  simply not recorded; a bare string is back-compat for {technique}. Posting
 *  time/day context is derived from posted_at and stored alongside. */
function recordPost(url, shape, postedAt) {
  if (!url || !shape) return;
  if (typeof shape === 'string') shape = { technique: shape };
  const dims = {};
  for (const [dim, values] of Object.entries(DIMENSIONS)) {
    if (shape[dim] && values.includes(shape[dim])) dims[dim] = shape[dim];
  }
  const at = postedAt || new Date().toISOString();
  const topic = typeof shape.topic === 'string'
    ? shape.topic.toLowerCase().replace(/[^a-z0-9 _-]+/g, '').trim().slice(0, 40)
    : '';
  const s = load();
  s.posts[url] = {
    ...(s.posts[url] || {}),
    ...dims,
    ...(topic ? { topic } : {}),
    time: timeBucket(at),
    day: dayBucket(at),
    posted_at: at,
  };
  save(s);
}

/** Store scraped engagement for a URL. engagement = weighted sum (see W);
 *  rate = weighted engagement per 100 impressions when reach was scraped. */
function recordMetric(url, { reactions = 0, comments = 0, reposts = 0, impressions = 0 } = {}) {
  const s = load();
  const prev = s.posts[url] || {};
  const weighted = W.reaction * (reactions || 0) + W.comment * (comments || 0) + W.repost * (reposts || 0);
  s.posts[url] = {
    ...prev, reactions, comments, reposts, impressions,
    engagement: weighted,
    rate: impressions > 0 ? +((100 * weighted) / impressions).toFixed(2) : null,
    measured_at: new Date().toISOString(),
  };
  save(s);
}

/** Posts old enough that engagement has accrued but not yet measured. */
function unmeasured({ olderThanHours = 24, staleAfterHours = 72 } = {}) {
  const s = load();
  const now = Date.now();
  const out = [];
  for (const [url, p] of Object.entries(s.posts)) {
    if (!p.posted_at) continue;   // any shape-tagged post gets measured (a dim may be missing, e.g. technique 'other')
    const age = (now - Date.parse(p.posted_at)) / 3600000;
    if (age < olderThanHours) continue;                       // too fresh to measure
    const measuredAge = p.measured_at ? (now - Date.parse(p.measured_at)) / 3600000 : Infinity;
    // measure once after it settles; re-measure only if the last measurement is old and the post is still young-ish
    if (p.engagement != null && (measuredAge < staleAfterHours || age > staleAfterHours * 2)) continue;
    out.push({ url, technique: p.technique, posted_at: p.posted_at });
  }
  return out;
}

/** Shrink a weighted-engagement count `e` over `imp` impressions toward a
 *  baseline rate `base` (per 100 impressions), using SHRINK_K pseudo-impressions
 *  of prior mass. Low reach ⇒ close to `base`; high reach ⇒ close to observed. */
function shrunkRate(e, imp, base) {
  return (100 * (e + (base / 100) * SHRINK_K)) / (imp + SHRINK_K);
}

/**
 * Precision-weighted, context-adjusted score per dimension value — the pure core
 * of dimensionStats(), taking an explicit post list so it is testable without
 * touching production state. Returns {dim: {value: {n, avgScore}}} where avgScore
 * is the impression-weighted mean RESIDUAL vs each post's context baseline
 * (0 = on par with its context, positive = above). Two small-sample fixes:
 *   1. Shrinkage — a low-reach post (e.g. 0 reactions / 40 impressions) no longer
 *      reads as a hard 0; its rate is pulled toward the baseline in proportion to
 *      how little reach it had (empirical Bayes, SHRINK_K).
 *   2. Confound control — each post is scored relative to the baseline rate of its
 *      CONTEXT_DIM bucket (default `day`), so "question_hook wins" means it beat
 *      its own context, not that it drew hotter topics/times. The bucket baseline
 *      collapses to the global pooled rate until it has MIN_CONTEXT posts, so it
 *      degrades gracefully on thin data.
 * A post counts only when impressions > 0 (no reach ⇒ no comparable rate).
 */
function scoreDimensions(posts) {
  const scored = [];
  let E = 0, I = 0;
  for (const p of posts) {
    const imp = Number(p.impressions) || 0;
    if (imp <= 0 || p.engagement == null) continue;   // not comparably measured
    const e = Number(p.engagement) || 0;
    scored.push({ p, imp, e });
    E += e; I += imp;
  }
  const G = I > 0 ? (100 * E) / I : 0;                 // global pooled rate (shrink target)

  const buckets = {};                                  // per-context-bucket accumulation
  for (const { p, imp, e } of scored) {
    const key = p[CONTEXT_DIM] || '';
    const b = buckets[key] || (buckets[key] = { e: 0, i: 0, n: 0 });
    b.e += e; b.i += imp; b.n++;
  }
  const baselineFor = (p) => {
    const b = buckets[p[CONTEXT_DIM] || ''];
    if (!b || b.n < MIN_CONTEXT || b.i <= 0) return G;  // thin bucket ⇒ global baseline
    return shrunkRate(b.e, b.i, G);                     // dense bucket, itself shrunk toward G
  };

  const out = {};
  for (const [dim, values] of Object.entries(DIMENSIONS)) {
    out[dim] = {};
    for (const v of values) out[dim][v] = { n: 0, _w: 0, _wsum: 0, avgScore: null };
  }
  for (const { p, imp, e } of scored) {
    const base = baselineFor(p);
    const residual = shrunkRate(e, imp, base) - base;  // post's rate vs its context, shrunk
    for (const dim of Object.keys(DIMENSIONS)) {
      const a = p[dim] && out[dim][p[dim]];
      if (!a) continue;
      a.n++; a._w += imp; a._wsum += imp * residual;    // impression-weighted
    }
  }
  for (const dim of Object.keys(out)) {
    for (const v of Object.keys(out[dim])) {
      const a = out[dim][v];
      a.avgScore = a._w > 0 ? +(a._wsum / a._w).toFixed(2) : null;
      delete a._w; delete a._wsum;
    }
  }
  return out;
}

/** Per-dimension per-value scores over MEASURED posts (assigned dims):
 *  {dim: {value: {n, avgScore}}}. avgScore = impression-weighted residual vs
 *  context baseline — see scoreDimensions(). */
function dimensionStats() {
  return scoreDimensions(Object.values(load().posts));
}

/** Context stats over MEASURED posts — recorded per post, never assigned by
 *  pickShape: posting time bucket, weekday/weekend, coarse topic slug. */
function observedStats() {
  const s = load();
  const acc = { time: {}, day: {}, topic: {} };
  for (const p of Object.values(s.posts)) {
    const score = postScore(p);
    if (score == null) continue;
    for (const dim of Object.keys(acc)) {
      const v = p[dim];
      if (!v) continue;
      const a = acc[dim][v] || (acc[dim][v] = { n: 0, total: 0 });
      a.n++; a.total += score;
    }
  }
  for (const dim of Object.keys(acc)) {
    for (const v of Object.keys(acc[dim])) {
      const a = acc[dim][v];
      a.avgScore = +(a.total / a.n).toFixed(2);
      delete a.total;
    }
  }
  return acc;
}

/** One explore/exploit pick within a single dimension. */
function pickValue(values, stat) {
  const under = values.filter((v) => stat[v].n < MIN_SAMPLES);
  if (under.length) {
    under.sort((a, b) => stat[a].n - stat[b].n);   // least-sampled first
    return { value: under[0], why: `explore (${stat[under[0]].n} sample(s))` };
  }
  if (Math.random() < EPS) {
    const v = values[Math.floor(Math.random() * values.length)];
    return { value: v, why: 'explore (epsilon)' };
  }
  let best = values[0];
  for (const v of values) if ((stat[v].avgScore ?? -1) > (stat[best].avgScore ?? -1)) best = v;
  return { value: best, why: `exploit (avg ${stat[best].avgScore})` };
}

/**
 * The A/B controller: assign the next post's test cell across every shape
 * dimension — force-explore under-sampled values, epsilon-greedy otherwise.
 * Returns {technique, ending, length, media, words: [lo, hi], why: {dim: reason}}.
 */
function pickShape() {
  const stats = dimensionStats();
  const shape = { why: {} };
  for (const [dim, values] of Object.entries(DIMENSIONS)) {
    const { value, why } = pickValue(values, stats[dim]);
    shape[dim] = value;
    shape.why[dim] = why;
  }
  shape.words = LENGTH_WORDS[shape.length];
  return shape;
}

/** Choose the next technique only (fallback template path): force-explore, else epsilon-greedy. */
function pickTechnique() {
  const stat = dimensionStats().technique;
  const { value } = pickValue(DIMENSIONS.technique, stat);
  return byId(value);
}

/** Per-technique averages over MEASURED posts (kept for back-compat). */
function techniqueStats() {
  const s = load();
  const acc = {};
  for (const t of TECHNIQUES) acc[t.id] = { id: t.id, label: t.label, n: 0, reactions: 0, comments: 0, engagement: 0 };
  for (const p of Object.values(s.posts)) {
    if (!p.technique || p.engagement == null || !acc[p.technique]) continue;
    const a = acc[p.technique];
    a.n++; a.reactions += p.reactions || 0; a.comments += p.comments || 0; a.engagement += p.engagement || 0;
  }
  for (const id of Object.keys(acc)) {
    const a = acc[id];
    a.avgEng = a.n ? +(a.engagement / a.n).toFixed(1) : null;
    a.avgReactions = a.n ? +(a.reactions / a.n).toFixed(1) : null;
    a.avgComments = a.n ? +(a.comments / a.n).toFixed(1) : null;
  }
  return acc;
}

/** Track-record paragraph for the draft/plan prompt: assigned shape dimensions
 *  first, then observed context (time/day/topic) as background. */
function summaryText() {
  const stats = dimensionStats();
  const lines = [];
  for (const [dim, values] of Object.entries(DIMENSIONS)) {
    const measured = values.filter((v) => stats[dim][v].n > 0);
    if (!measured.length) continue;
    const row = values.map((v) => {
      const a = stats[dim][v];
      return a.n ? `${v}: avg ${a.avgScore} (${a.n})` : `${v}: no data`;
    }).join(' | ');
    lines.push(`  • ${dim} — ${row}`);
  }
  if (!lines.length) return '';
  const out = [`YOUR LINKEDIN POSTING TRACK RECORD, by shape dimension [avg score (measured posts)] — score = engagement rate (reactions + 2×comments + 3×reposts per 100 impressions) RELATIVE TO your baseline for that context; 0 = par, positive = above, negative = below:`, ...lines];

  const obs = observedStats();
  const obsLines = [];
  for (const dim of ['time', 'day', 'topic']) {
    const entries = Object.entries(obs[dim]);
    if (!entries.length) continue;
    entries.sort((a, b) => b[1].avgScore - a[1].avgScore);
    obsLines.push(`  • ${dim} — ${entries.slice(0, 6).map(([v, a]) => `${v}: avg ${a.avgScore} (${a.n})`).join(' | ')}`);
  }
  if (obsLines.length) out.push(`Context (observed, not part of the experiment — background only):`, ...obsLines);
  out.push(`This is measured, not guessed.`);
  return out.join('\n');
}

module.exports = {
  TECHNIQUES, DIMENSIONS, LENGTH_WORDS, byId, lengthBucket, postScore,
  recordPost, recordMetric, unmeasured,
  dimensionStats, scoreDimensions, shrunkRate, observedStats, techniqueStats, pickShape, pickTechnique, summaryText,
};
