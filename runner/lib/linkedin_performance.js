'use strict';
/**
 * runner/lib/linkedin_performance.js — the "test and learn" loop for Sebastian's
 * LinkedIn posting. Each post is tagged with an opening TECHNIQUE; engagement
 * (reactions + comments) is measured after it accrues; the technique→engagement
 * profile is fed back into the draft prompt and biases technique selection
 * (explore/exploit). Same shape as the prediction-calibration loop.
 *
 *   pickTechnique()      -> a technique to use next (epsilon-greedy + force-explore)
 *   summaryText()        -> track-record string for the draft prompt
 *   recordPost(url,tech) -> tag a freshly-posted URL with its technique
 *   recordMetric(url,m)  -> store scraped {reactions,comments} for a URL
 *   unmeasured({hours})  -> posts old enough to measure but not yet measured
 *   techniqueStats()     -> {id: {n, avgEng, avgReactions, avgComments}}
 *
 * Metric optimized: ENGAGEMENT = reactions + comments (user-chosen). Pure JS.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const STORE = path.join(config.STATE_DIR, 'linkedin_post_metrics.json');
const MIN_SAMPLES = Number(process.env.LI_LEARN_MIN_SAMPLES) || 2;   // force-explore until each technique has this many measured posts
const EPS = Number(process.env.LI_LEARN_EPSILON) || 0.3;             // explore probability once warmed up

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

/** Tag a freshly-posted URL with the technique it used (engagement filled in later). */
function recordPost(url, technique, postedAt) {
  if (!url || !technique) return;
  const s = load();
  s.posts[url] = { ...(s.posts[url] || {}), technique, posted_at: postedAt || new Date().toISOString() };
  save(s);
}

/** Store scraped engagement for a URL. engagement = reactions + comments. */
function recordMetric(url, { reactions = 0, comments = 0 } = {}) {
  const s = load();
  const prev = s.posts[url] || {};
  s.posts[url] = { ...prev, reactions, comments, engagement: (reactions || 0) + (comments || 0), measured_at: new Date().toISOString() };
  save(s);
}

/** Posts old enough that engagement has accrued but not yet measured. */
function unmeasured({ olderThanHours = 24, staleAfterHours = 72 } = {}) {
  const s = load();
  const now = Date.now();
  const out = [];
  for (const [url, p] of Object.entries(s.posts)) {
    if (!p.technique) continue;
    const age = p.posted_at ? (now - Date.parse(p.posted_at)) / 3600000 : 0;
    if (age < olderThanHours) continue;                       // too fresh to measure
    const measuredAge = p.measured_at ? (now - Date.parse(p.measured_at)) / 3600000 : Infinity;
    // measure once after it settles; re-measure only if the last measurement is old and the post is still young-ish
    if (p.engagement != null && (measuredAge < staleAfterHours || age > staleAfterHours * 2)) continue;
    out.push({ url, technique: p.technique, posted_at: p.posted_at });
  }
  return out;
}

/** Per-technique averages over MEASURED posts. */
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

/** Choose the next technique: force-explore under-sampled ones, else epsilon-greedy on avg engagement. */
function pickTechnique() {
  const stats = techniqueStats();
  const under = TECHNIQUES.filter((t) => stats[t.id].n < MIN_SAMPLES);
  if (under.length) {
    // least-sampled first, deterministic-ish
    under.sort((a, b) => stats[a.id].n - stats[b.id].n);
    return under[0];
  }
  if (Math.random() < EPS) return TECHNIQUES[Math.floor(Math.random() * TECHNIQUES.length)];
  let best = TECHNIQUES[0];
  for (const t of TECHNIQUES) if ((stats[t.id].avgEng ?? -1) > (stats[best.id].avgEng ?? -1)) best = t;
  return best;
}

/** Track-record paragraph for the draft prompt. */
function summaryText() {
  const stats = techniqueStats();
  const measured = TECHNIQUES.filter((t) => stats[t.id].n > 0);
  if (!measured.length) return '';
  const rows = TECHNIQUES.map((t) => {
    const a = stats[t.id];
    return a.n ? `  • ${t.label}: avg ${a.avgEng} engagement (${a.avgReactions} reactions + ${a.avgComments} comments) over ${a.n} post(s)` : `  • ${t.label}: no data yet`;
  }).join('\n');
  const best = measured.reduce((b, t) => (stats[t.id].avgEng > stats[b.id].avgEng ? t : b), measured[0]);
  return `YOUR LINKEDIN POSTING TRACK RECORD (engagement = reactions + comments), by opening technique:\n${rows}\n` +
    `Best-performing so far: "${best.label}". Lean into what actually resonates — this is measured, not guessed.`;
}

module.exports = { TECHNIQUES, byId, recordPost, recordMetric, unmeasured, techniqueStats, pickTechnique, summaryText };
