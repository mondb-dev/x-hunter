#!/usr/bin/env node
/**
 * runner/source_selector.js — queue off-platform sources for regular browse
 *
 * Uses Sebastian's strongest current convictions to periodically enqueue a
 * reputable external source URL into state/reading_queue.jsonl. This makes
 * off-platform reading part of the normal browse loop instead of only a
 * fallback when X is unavailable.
 *
 * Priority rules:
 *   - Never override an existing pending reading item.
 *   - Queue at most one pending conviction-driven source at a time.
 *   - Prefer vocation/core axes and high-confidence, evidence-rich axes.
 *
 * Usage:
 *   SOURCE_SELECT_CYCLE=12 node runner/source_selector.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { canonicalDomain } = require("./lib/url_utils");

const ROOT = path.resolve(__dirname, "..");
const ONTOLOGY = path.join(ROOT, "state", "ontology.json");
const VOCATION = path.join(ROOT, "state", "vocation.json");
const QUEUE_FILE = path.join(ROOT, "state", "reading_queue.jsonl");
const PLAN_FILE = path.join(ROOT, "state", "source_plan.json");
const EXTERNAL_SOURCES = path.join(ROOT, "state", "external_sources.json");

const CURRENT_CYCLE = parseInt(process.env.SOURCE_SELECT_CYCLE || "0", 10);
const SELECT_EVERY = 3;
const MIN_CONFIDENCE = 0.7;
const MIN_EVIDENCE = 4;
const MIN_ABS_SCORE = 0.08;
const MAX_PENDING_CONVICTION_ITEMS = 1;
const HISTORY_LIMIT = 24;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "this", "that", "their", "they",
  "have", "has", "been", "were", "will", "would", "about", "after", "before",
  "between", "under", "over", "through", "public", "discourse", "truth", "evidence",
  "social", "media", "political", "politics", "global", "human", "rights",
  "vs", "rule", "law", "power",
]);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function domainFromUrl(url) {
  try {
    return canonicalDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs.readFileSync(QUEUE_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendQueue(entry) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

function summariseQueue(entries) {
  const byUrl = new Map();
  for (const entry of entries) {
    if (!entry.url) continue;
    if (!byUrl.has(entry.url)) byUrl.set(entry.url, { url: entry.url });
    const state = byUrl.get(entry.url);
    if (entry.from_user) state.from_user = entry.from_user;
    if (entry.context) state.context = entry.context;
    if (entry.added_at) state.added = true;
    if (entry.in_progress_cycle !== undefined) state.in_progress = true;
    if (entry.consumed_at) state.consumed = true;
  }
  return [...byUrl.values()];
}

function extractKeywords(...chunks) {
  const seen = new Set();
  const words = [];
  for (const chunk of chunks) {
    const parts = String(chunk || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 2 && !STOPWORDS.has(word));
    for (const word of parts) {
      if (seen.has(word)) continue;
      seen.add(word);
      words.push(word);
    }
  }
  return words;
}

function axisCategory(axis, vocation) {
  const haystack = [
    axis.id,
    axis.label,
    axis.left_pole,
    axis.right_pole,
    vocation.label,
    vocation.description,
    vocation.intent,
  ].join(" ").toLowerCase();

  if (/(epistemic|media|information|disinformation|misinformation|propaganda|collective_voice|consent|manipulation)/.test(haystack)) {
    return {
      name: "disinformation_accountability",
      query: ["disinformation", "accountability", "corruption", "evidence"],
    };
  }
  if (/(accountability|corruption|rule of law|power|institution|trust|watchdog)/.test(haystack)) {
    return {
      name: "accountability_investigation",
      query: ["corruption", "accountability", "investigation", "governance"],
    };
  }
  if (/(geopolitic|sovereignty|international law|war|conflict|humanitarian|economic|hegemony)/.test(haystack)) {
    return {
      name: "world_affairs",
      query: ["conflict", "international law", "geopolitics", "analysis"],
    };
  }
  if (/(artificial intelligence| ai |robots|scientific|consciousness|neuroscience|ethic)/.test(` ${haystack} `)) {
    return {
      name: "research",
      query: ["artificial intelligence", "ethics", "research", "policy"],
    };
  }
  return {
    name: "public_interest",
    query: extractKeywords(axis.label, vocation.label, vocation.description).slice(0, 5),
  };
}

function buildQuery(axis, vocation, category) {
  const axisWords = extractKeywords(axis.label, axis.left_pole, axis.right_pole).slice(0, 4);
  const vocationWords = extractKeywords(vocation.label, vocation.description).slice(0, 2);
  const terms = [];

  for (const term of [...category.query, ...axisWords, ...vocationWords]) {
    if (!term || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= 6) break;
  }

  return terms.join(" ");
}

function buildCandidates(categoryName, query) {
  const q = encodeURIComponent(query);
  if (categoryName === "research") {
    return [
      { label: "arXiv", url: `https://arxiv.org/search/?query=${q}&searchtype=all&abstracts=show&order=-announced_date_first&size=50` },
      { label: "PubMed", url: `https://pubmed.ncbi.nlm.nih.gov/?term=${q}` },
      { label: "Nature", url: `https://www.nature.com/search?q=${q}` },
      { label: "Reuters", url: `https://www.reuters.com/site-search/?query=${q}` },
    ];
  }

  if (categoryName === "world_affairs") {
    return [
      { label: "Reuters", url: `https://www.reuters.com/site-search/?query=${q}` },
      { label: "AP", url: `https://apnews.com/search?q=${q}` },
      { label: "BBC", url: `https://www.bbc.co.uk/search?q=${q}` },
      { label: "CourtListener", url: `https://www.courtlistener.com/?q=${q}` },
    ];
  }

  if (categoryName === "accountability_investigation" || categoryName === "disinformation_accountability") {
    return [
      { label: "ProPublica", url: `https://www.propublica.org/search?q=${q}` },
      { label: "CourtListener", url: `https://www.courtlistener.com/?q=${q}` },
      { label: "Reuters", url: `https://www.reuters.com/site-search/?query=${q}` },
      { label: "AP", url: `https://apnews.com/search?q=${q}` },
      { label: "BBC", url: `https://www.bbc.co.uk/search?q=${q}` },
    ];
  }

  return [
    { label: "Reuters", url: `https://www.reuters.com/site-search/?query=${q}` },
    { label: "AP", url: `https://apnews.com/search?q=${q}` },
    { label: "BBC", url: `https://www.bbc.co.uk/search?q=${q}` },
    { label: "ProPublica", url: `https://www.propublica.org/search?q=${q}` },
  ];
}

function loadRegistryScores() {
  const registry = readJson(EXTERNAL_SOURCES, { sources: [] });
  const scores = new Map();
  for (const source of registry.sources || []) {
    if (!source.domain) continue;
    const baseOverall = source.ratings?.overall?.score ?? 0;
    const profileScore = source.ratings?.profile?.score ?? null;
    const profileConfidence = source.ratings?.profile?.confidence ?? 0;
    scores.set(source.domain, {
      overall: profileScore === null
        ? baseOverall
        : ((baseOverall * 0.7) + (profileScore * 0.3)),
      confidence: Math.min(
        1,
        (source.ratings?.overall?.confidence ?? 0) + (profileScore === null ? 0 : profileConfidence * 0.15)
      ),
      observations: source.discovery?.distinct_urls ?? 0,
    });
  }
  return scores;
}

function rankCandidates(candidates, registryScores) {
  return [...candidates].sort((a, b) => {
    const da = registryScores.get(domainFromUrl(a.url)) || { overall: 0, confidence: 0, observations: 0 };
    const db = registryScores.get(domainFromUrl(b.url)) || { overall: 0, confidence: 0, observations: 0 };
    const sa = (da.overall * 0.7) + (da.confidence * 0.2) + Math.min(da.observations / 10, 1) * 0.1;
    const sb = (db.overall * 0.7) + (db.confidence * 0.2) + Math.min(db.observations / 10, 1) * 0.1;
    return sb - sa;
  });
}

function axisStrength(axis, vocation) {
  const confidence = axis.confidence || 0;
  const evidenceCount = (axis.evidence_log || []).length;
  const absScore = Math.abs(axis.score || 0);
  if (confidence < MIN_CONFIDENCE || evidenceCount < MIN_EVIDENCE || absScore < MIN_ABS_SCORE) {
    return -1;
  }

  let strength = confidence * (0.4 + absScore) * (1 + Math.min(evidenceCount / 30, 1));
  if (Array.isArray(vocation.core_axes) && vocation.core_axes.includes(axis.id)) strength *= 1.35;
  if (Array.isArray(vocation.hardened_axes) && vocation.hardened_axes.includes(axis.id)) strength *= 1.1;
  return strength;
}

function loadHistory(plan) {
  return Array.isArray(plan.history) ? plan.history : [];
}

function recentAxisPenalty(axisId, history) {
  const recent = history.slice(-6);
  const repeats = recent.filter(item => item.axis_id === axisId).length;
  return 1 + (repeats * 0.75);
}

function pickAxis(axes, vocation, history) {
  return axes
    .map(axis => ({
      axis,
      score: axisStrength(axis, vocation) / recentAxisPenalty(axis.id, history),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function main() {
  const ontology = readJson(ONTOLOGY, { axes: [] });
  const vocation = readJson(VOCATION, {});
  const existingPlan = readJson(PLAN_FILE, {});
  const history = loadHistory(existingPlan);

  const plan = {
    version: 1,
    cycle: CURRENT_CYCLE,
    updated_at: new Date().toISOString(),
    skipped_reason: null,
    selected_axis_id: null,
    selected_axis_label: null,
    bundle: null,
    query: null,
    candidates: [],
    queued_url: null,
    queued_source: null,
    history,
  };

  if (!CURRENT_CYCLE || CURRENT_CYCLE % SELECT_EVERY !== 0) {
    plan.skipped_reason = `cycle_gate:${SELECT_EVERY}`;
    writeJson(PLAN_FILE, plan);
    return;
  }

  const queueEntries = summariseQueue(loadQueue());
  const pendingItems = queueEntries.filter(entry => entry.added && !entry.consumed);
  const pendingExternal = pendingItems.filter(entry => entry.from_user === "conviction_source");

  if (pendingItems.some(entry => entry.from_user && entry.from_user !== "conviction_source")) {
    plan.skipped_reason = "reading_queue_busy";
    writeJson(PLAN_FILE, plan);
    return;
  }

  if (pendingExternal.length >= MAX_PENDING_CONVICTION_ITEMS) {
    plan.skipped_reason = "conviction_source_already_pending";
    writeJson(PLAN_FILE, plan);
    return;
  }

  const chosen = pickAxis(ontology.axes || [], vocation, history);
  if (!chosen) {
    plan.skipped_reason = "no_compelling_axis";
    writeJson(PLAN_FILE, plan);
    return;
  }

  const category = axisCategory(chosen.axis, vocation);
  const query = buildQuery(chosen.axis, vocation, category);
  const registryScores = loadRegistryScores();
  const candidates = rankCandidates(buildCandidates(category.name, query), registryScores);
  const seenUrls = new Set(queueEntries.map(entry => entry.url));
  const candidate = candidates.find(item => !seenUrls.has(item.url)) || candidates[0];

  plan.selected_axis_id = chosen.axis.id;
  plan.selected_axis_label = chosen.axis.label;
  plan.bundle = category.name;
  plan.query = query;
  plan.candidates = candidates;

  if (!candidate) {
    plan.skipped_reason = "no_candidate_url";
    writeJson(PLAN_FILE, plan);
    return;
  }

  const context = [
    `Conviction research for ${chosen.axis.label}.`,
    `Why now: confidence ${(chosen.axis.confidence * 100).toFixed(0)}%, score ${(chosen.axis.score || 0).toFixed(2)}, ${(chosen.axis.evidence_log || []).length} evidence entries.`,
    `Target source: ${candidate.label}.`,
    `Search focus: ${query}.`,
    `Goal: gather off-platform evidence that can sharpen or challenge this axis.`,
  ].join(" ");

  appendQueue({
    url: candidate.url,
    from_user: "conviction_source",
    context,
    added_cycle: CURRENT_CYCLE,
    added_at: new Date().toISOString(),
    priority: "normal",
  });

  plan.queued_url = candidate.url;
  plan.queued_source = candidate.label;
  plan.history = history.concat([{
    ts: new Date().toISOString(),
    axis_id: chosen.axis.id,
    axis_label: chosen.axis.label,
    bundle: category.name,
    source: candidate.label,
    url: candidate.url,
    query,
  }]).slice(-HISTORY_LIMIT);

  writeJson(PLAN_FILE, plan);
  console.log(`[source_selector] queued ${candidate.label} for ${chosen.axis.id}`);
}

async function selectAdversarialSource() {
  // Fire once per day — check last run date in source_plan.json
  const plan = fs.existsSync(PLAN_FILE)
    ? JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'))
    : {};
  const lastAdv = plan.last_adversarial_date || '';
  const today = new Date().toISOString().slice(0, 10);
  if (lastAdv === today) return { skipped: true, reason: 'already ran today' };

  // Load ontology, find highest-confidence axis with |score| > 0.3
  if (!fs.existsSync(ONTOLOGY)) return { skipped: true, reason: 'no ontology' };
  const ontology = JSON.parse(fs.readFileSync(ONTOLOGY, 'utf8'));
  const axes = ontology.axes || [];
  const candidates = axes
    .filter(a => a.confidence >= 0.7 && Math.abs(a.score || 0) > 0.3 && (a.evidence_log || []).length >= 4)
    .sort((a, b) => b.confidence - a.confidence);
  if (!candidates.length) return { skipped: true, reason: 'no qualifying axis' };

  const axis = candidates[0];
  const counterDirection = (axis.score || 0) > 0 ? 'against' : 'supporting';
  const counterPole = (axis.score || 0) > 0 ? (axis.left_pole || axis.negative_pole || 'opposing view') : (axis.right_pole || axis.positive_pole || 'opposing view');

  // Build search query targeting the counter-pole
  const searchTerms = [counterPole, axis.label].filter(Boolean).join(' ');

  // Select from credible sources only
  const credibleSources = [
    `https://www.reuters.com/site-search/?query=${encodeURIComponent(searchTerms)}`,
    `https://apnews.com/search?q=${encodeURIComponent(searchTerms)}`,
    `https://www.bbc.co.uk/search?q=${encodeURIComponent(searchTerms)}`,
    `https://www.theguardian.com/search?q=${encodeURIComponent(searchTerms)}`,
    `https://scholar.google.com/scholar?q=${encodeURIComponent(searchTerms)}`,
  ];
  const chosen = credibleSources[Math.floor(Math.random() * credibleSources.length)];

  // Append to reading queue
  const queueEntry = {
    url: chosen,
    from_user: 'adversarial_selector',
    axis: axis.label,
    counter_direction: counterDirection,
    counter_pole: counterPole,
    axis_score: axis.score,
    added_at: new Date().toISOString(),
    queued_at: Date.now(),
  };
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(queueEntry) + '\n');

  // Update last_adversarial_date in source_plan.json
  plan.last_adversarial_date = today;
  writeJson(PLAN_FILE, plan);

  console.log(`[source_selector] adversarial: queued counter-argument search for axis "${axis.label}" (score ${(axis.score || 0).toFixed(2)}) -> ${counterDirection} ${counterPole}`);
  return { queued: true, axis: axis.label, url: chosen };
}

module.exports = { selectConvictionSource: main, selectAdversarialSource };

try {
  main();
} catch (err) {
  console.error(`[source_selector] error: ${err.message}`);
  process.exit(0);
}
