#!/usr/bin/env node
/**
 * runner/source_followup.js — queue trusted external sources for periodic revisit
 *
 * Reads state/external_sources.json (built by external_source_discovery.js).
 * For each high-trust news/academic/official domain, periodically adds one
 * representative URL to state/reading_queue.jsonl so the browse agent revisits
 * known good sources — not just waiting for them to appear in X posts.
 *
 * Gate: each domain queued at most once every REVISIT_HOURS (default 72h).
 * Max 3 URLs queued per run to avoid crowding the reading queue.
 *
 * State: state/source_followup_state.json
 *        { "domain": { "last_queued": "ISO", "url": "..." }, ... }
 *
 * Usage: node runner/source_followup.js
 * Called from run.sh after each browse cycle (non-fatal).
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const config = require("./lib/config");

const ROOT         = config.PROJECT_ROOT;
const STATE_DIR    = config.STATE_DIR;
const SOURCES_PATH = config.EXTERNAL_SOURCES_PATH;
const QUEUE_FILE   = path.join(STATE_DIR, "reading_queue.jsonl");
const STATE_FILE   = path.join(STATE_DIR, "source_followup_state.json");

const REVISIT_HOURS  = 72;    // minimum hours between revisits of the same domain
const MAX_PER_RUN    = 3;     // max URLs to queue in one run
const ELIGIBLE_KINDS = new Set(["news", "academic", "official"]);
const MIN_DISTINCT   = 1;     // domain must have been seen in >= N distinct URLs to qualify

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

function appendQueue(entry) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

function hoursSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 3_600_000;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const extSources = loadJson(SOURCES_PATH);
  if (!extSources || !extSources.sources) {
    console.log("[source_followup] external_sources.json not found or empty — skipping");
    return;
  }

  const followupState = loadJson(STATE_FILE) || {};
  const sources = Object.values(extSources.sources || {});

  // Filter: eligible kind, has example URLs, seen enough times
  const candidates = sources.filter(s => {
    if (!ELIGIBLE_KINDS.has(s.kind)) return false;
    const urls = s.discovery?.example_urls;
    if (!urls || urls.length === 0) return false;
    if ((s.discovery?.distinct_urls || 0) < MIN_DISTINCT) return false;
    return true;
  });

  // Score: prefer domains not recently queued, with more distinct URLs (more evidence = more trusted)
  const scored = candidates.map(s => {
    const stateEntry = followupState[s.domain] || {};
    const age = hoursSince(stateEntry.last_queued);
    const distinctUrls = s.discovery?.distinct_urls || 1;
    return {
      domain: s.domain,
      kind: s.kind,
      age,
      score: age * Math.log(1 + distinctUrls),
      urls: s.discovery.example_urls,
    };
  }).filter(s => s.age >= REVISIT_HOURS);

  // Sort by score descending (highest age × distinctness first)
  scored.sort((a, b) => b.score - a.score);

  const toQueue = scored.slice(0, MAX_PER_RUN);

  if (toQueue.length === 0) {
    console.log("[source_followup] no domains due for revisit — skipping");
    return;
  }

  let queued = 0;
  for (const s of toQueue) {
    // Pick the most recently seen URL from this domain
    const url = s.urls[s.urls.length - 1];
    if (!url || !url.startsWith("http")) continue;

    appendQueue({
      url,
      source: "source_followup",
      domain: s.domain,
      kind: s.kind,
      queued_at: new Date().toISOString(),
    });

    followupState[s.domain] = {
      last_queued: new Date().toISOString(),
      url,
    };

    console.log(`[source_followup] queued ${s.domain} (${s.kind}): ${url}`);
    queued++;
  }

  if (queued > 0) saveJson(STATE_FILE, followupState);
  console.log(`[source_followup] done — ${queued} URL(s) queued`);
}

try {
  main();
} catch (err) {
  console.error(`[source_followup] error: ${err.message}`);
  process.exit(0); // non-fatal
}
