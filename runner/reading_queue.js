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

/** URLs to skip — bare tweet/profile links add no reading value */
function isSkippableUrl(url) {
  return /https?:\/\/(www\.)?(x\.com|twitter\.com|t\.co)\//i.test(url);
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
      .filter(u => !isSkippableUrl(u));

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

function emitTopItem() {
  const entries = loadQueue();

  // Build consumed + in-progress URL sets
  const consumed = new Set(
    entries.filter(e => e.consumed_at).map(e => e.url)
  );
  const inProgress = new Set(
    entries.filter(e => e.in_progress_cycle !== undefined && !e.consumed_at).map(e => e.url)
  );

  // Find oldest unread item that is not stale
  const candidate = entries.find(e => {
    if (!e.url || !e.added_cycle) return false;
    if (consumed.has(e.url)) return false;
    if (inProgress.has(e.url)) return false;
    if (CYCLE - e.added_cycle > STALE_CYCLES) return false;
    // Only consider queue entries (has from_user), not markers
    return Boolean(e.from_user);
  });

  if (!candidate) {
    fs.writeFileSync(READING_URL, "", "utf-8");
    return null;
  }

  // Write reading_url.txt
  const content = [
    `URL: ${candidate.url}`,
    `FROM: @${candidate.from_user}`,
    `CONTEXT: ${candidate.context || ""}`,
  ].join("\n");
  fs.writeFileSync(READING_URL, content + "\n", "utf-8");

  // Append in-progress marker
  appendQueue({ url: candidate.url, in_progress_cycle: CYCLE });

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
