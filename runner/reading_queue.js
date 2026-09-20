#!/usr/bin/env node
/**
 * runner/reading_queue.js — scan reply interactions for user-recommended URLs
 *
 * Default mode: scans state/interactions.json for new replies containing external URLs,
 * queues them in state/reading_queue.jsonl, and emits the top unread item to
 * state/reading_url.txt so run.sh can inject it into the browse agent's message.
 *
 * --mark-done mode: marks the current reading_url.txt item as consumed.
 *
 * Non-fatal: exits 0 on any error.
 *
 * Usage:
 *   READING_CYCLE=50 node runner/reading_queue.js
 *   READING_CYCLE=50 node runner/reading_queue.js --mark-done
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT         = path.resolve(__dirname, "..");
const INTERACTIONS = path.join(ROOT, "state", "interactions.json");
const QUEUE_FILE   = path.join(ROOT, "state", "reading_queue.jsonl");
const SCAN_STATE   = path.join(ROOT, "state", "reading_queue_state.json");
const READING_URL  = path.join(ROOT, "state", "reading_url.txt");

const CYCLE        = parseInt(process.env.READING_CYCLE || "0", 10);
const STALE_CYCLES = 24;

// --- helpers -----------------------------------------------------------------

function loadScanState() {
  try {
    if (fs.existsSync(SCAN_STATE)) {
      return JSON.parse(fs.readFileSync(SCAN_STATE, "utf-8"));
    }
  } catch { /* corrupt — reset */ }
  return { last_scanned_id: null };
}

function saveScanState(state) {
  fs.writeFileSync(SCAN_STATE, JSON.stringify(state, null, 2), "utf-8");
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs.readFileSync(QUEUE_FILE, "utf-8")
    .split("\n")
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function appendQueue(line) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(line) + "\n", "utf-8");
}

/** Only allow x.com URLs — keeps the agent on-platform and avoids external navigation risks.
 *  t.co is excluded even though it's Twitter's shortener (it redirects to arbitrary external sites). */
function isAllowedUrl(url) {
  return /https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(url);
}

// --- scan mode ---------------------------------------------------------------

function scanInteractions(lastScannedId) {
  if (!fs.existsSync(INTERACTIONS)) return { newUrls: 0, highestId: lastScannedId };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(INTERACTIONS, "utf-8"));
  } catch {
    return { newUrls: 0, highestId: lastScannedId };
  }

  const replies = data.replies || [];
  let newUrls = 0;
  let highestId = lastScannedId;

  for (const reply of replies) {
    const id = String(reply.id || "");
    if (!id) continue;

    // Track highest id seen (lexicographic — tweet IDs are monotonically increasing strings)
    if (!highestId || id > highestId) highestId = id;

    // Skip already-scanned
    if (lastScannedId && id <= lastScannedId) continue;

    const text = reply.their_text || "";
    const urls = (text.match(/https?:\/\/\S+/g) || [])
      .map(u => u.replace(/[.,;:!?)]+$/, "")) // strip trailing punctuation
      .filter(u => isAllowedUrl(u));

    // Also extract @mentions (excluding the agent itself) and queue as profile URLs
    const mentionedAccounts = (text.match(/@(\w+)/g) || [])
      .map(m => m.slice(1).toLowerCase())
      .filter(u => u !== "sebhunts_ai" && u !== "sebastianhunts" && u.length > 1);
    for (const account of mentionedAccounts) {
      const profileUrl = `https://x.com/${account}`;
      if (!urls.includes(profileUrl)) urls.push(profileUrl);
    }

    for (const url of urls) {
      const context = text.length > 120 ? text.slice(0, 117) + "..." : text;
      appendQueue({
        url,
        from_user: reply.from || "unknown",
        context,
        added_cycle: CYCLE,
        added_at: new Date().toISOString(),
        priority: "high",
      });
      newUrls++;
      console.log(`[reading_queue] queued from @${reply.from}: ${url}`);
    }
  }

  return { newUrls, highestId };
}

// --- emit top item -----------------------------------------------------------

// Machine producers. rss_collect / search_curiosity / source_followup write
// `source` + `queued_at` instead of `from_user` + `added_cycle`; before
// 2026-09-15 this function required the latter, so those producers' thousands
// of entries were never emitted. Machine entries go stale by wall clock.
const MACHINE_ORIGINS = new Set([
  "rss_collect", "search_curiosity", "source_followup",
  "conviction_source", "adversarial_selector", "agenda_source",
]);
const STALE_MS = 12 * 60 * 60 * 1000;

function entryOrigin(e) {
  return e.from_user || e.source || null;
}

function entryTime(e) {
  const raw = e.added_at || e.queued_at; // adversarial_selector writes queued_at as epoch ms
  const t = typeof raw === "number" ? raw : Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

function isFresh(e) {
  if (e.added_cycle) return CYCLE - e.added_cycle <= STALE_CYCLES;
  const t = entryTime(e);
  return t > 0 && Date.now() - t <= STALE_MS;
}

/**
 * Latest read-marker time per URL. A queue entry is eligible only if it was
 * added AFTER its URL was last emitted/consumed, so a source page re-queued
 * later (agenda sources are revisited on purpose) can be read again. Legacy
 * in-progress markers carry no timestamp and block their URL forever, which
 * preserves the old read-once behavior for them.
 */
function lastMarks(entries) {
  const marks = new Map();
  const bump = (url, t) => { if (!(marks.get(url) >= t)) marks.set(url, t); };
  for (const e of entries) {
    if (!e.url) continue;
    if (e.consumed_at) bump(e.url, Date.parse(e.consumed_at) || Infinity);
    else if (e.in_progress_cycle !== undefined) bump(e.url, e.in_progress_at ? Date.parse(e.in_progress_at) : Infinity);
  }
  return marks;
}

/**
 * Emission order: people who sent Sebastian a link (and deep-dive detection)
 * first, then agenda-relevant machine entries, then the rest — oldest first
 * within each group. Under a full_pivot research agenda, off-agenda machine
 * entries are never emitted.
 */
function pickCandidate(entries) {
  const marks = lastMarks(entries);
  const { getAgenda, isFullPivot, isOnAgenda } = require("./lib/research_agenda");
  const agenda = getAgenda();

  const groups = [[], [], []];
  for (const e of entries) {
    const origin = entryOrigin(e);
    if (!e.url || !origin) continue; // markers (in-progress / consumed)
    if (marks.get(e.url) >= entryTime(e) || !isFresh(e)) continue;
    if (!MACHINE_ORIGINS.has(origin)) { groups[0].push(e); continue; }
    const onAgenda = !!agenda && (e.agenda === true ||
      isOnAgenda([e.url, e.title, e.context, e.why, e.research_focus, e.axis_hint].join(" "), agenda));
    if (onAgenda) groups[1].push(e);
    else if (!isFullPivot(agenda)) groups[2].push(e);
  }
  return groups[0][0] || groups[1][0] || groups[2][0] || null;
}

function emitTopItem() {
  const candidate = pickCandidate(loadQueue());

  if (!candidate) {
    fs.writeFileSync(READING_URL, "", "utf-8");
    return null;
  }

  // Write reading_url.txt
  const context = candidate.context ||
    [candidate.title, candidate.why, candidate.research_focus && `research focus: ${candidate.research_focus}`]
      .filter(Boolean).join(" — ");
  const content = [
    `URL: ${candidate.url}`,
    `FROM: @${entryOrigin(candidate)}`,
    `CONTEXT: ${context}`,
  ].join("\n");
  fs.writeFileSync(READING_URL, content + "\n", "utf-8");

  // Append in-progress marker
  appendQueue({ url: candidate.url, in_progress_cycle: CYCLE, in_progress_at: new Date().toISOString() });

  return candidate.url;
}

// --- mark-done mode ----------------------------------------------------------

function markDone() {
  if (!fs.existsSync(READING_URL)) return;
  const text = fs.readFileSync(READING_URL, "utf-8").trim();
  if (!text) return;

  const urlMatch = text.match(/^URL:\s*(.+)$/m);
  if (!urlMatch) return;
  const url = urlMatch[1].trim();

  appendQueue({ url, consumed_at: new Date().toISOString(), consumed_cycle: CYCLE });
  fs.writeFileSync(READING_URL, "", "utf-8");
  console.log(`[reading_queue] marked done: ${url}`);
}

// --- main --------------------------------------------------------------------

(async () => {
  try {
    const markDoneMode = process.argv.includes("--mark-done");

    if (markDoneMode) {
      markDone();
      process.exit(0);
    }

    // Scan for new URLs
    const state = loadScanState();
    const { newUrls, highestId } = scanInteractions(state.last_scanned_id);
    if (highestId !== state.last_scanned_id) {
      saveScanState({ last_scanned_id: highestId });
    }

    // Emit top item
    const emitted = emitTopItem();
    if (emitted) {
      console.log(`[reading_queue] ${newUrls} URL(s) queued - emitting: ${emitted}`);
    } else {
      console.log(`[reading_queue] ${newUrls} URL(s) queued - queue empty`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`[reading_queue] error: ${err.message}`);
    process.exit(0);
  }
})();
