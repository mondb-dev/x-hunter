"use strict";
/**
 * scraper/lib/reply_queue.js — canonical mention-queue dedup + append.
 *
 * Extracted verbatim from collect.js so the fast mentions poller
 * (scraper/mentions.js) and collect.js's Phase-12 fallback write byte-identical
 * records and dedupe against the same state, with no schema drift between them.
 * Both append with the 'a' flag (O_APPEND) — each write lands atomically at EOF,
 * so concurrent appends from the two processes don't interleave lines.
 */

const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..", "..");
const REPLY_QUEUE = path.join(ROOT, "state", "reply_queue.jsonl");

function loadQueuedReplyIds() {
  const existingIds = new Set();
  try {
    const raw = fs.readFileSync(REPLY_QUEUE, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of raw) {
      try { existingIds.add(JSON.parse(line).id); } catch {}
    }
  } catch {}
  try {
    const inter = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "interactions.json"), "utf-8"));
    for (const r of (inter.replies || [])) {
      if (r.id) existingIds.add(r.id);
    }
  } catch {}
  return existingIds;
}

function appendMentionsToReplyQueue(mentions) {
  const existingIds = loadQueuedReplyIds();
  const newItems = [];
  for (const m of mentions) {
    if (!m.text || !m.id || existingIds.has(m.id)) continue;
    const stripped = m.text.replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
    // Lower threshold: a bare @mention with 1-2 words is still worth replying to
    if (stripped.length < 2) continue;
    newItems.push(JSON.stringify({
      id:               m.id,
      ts:               m.ts,
      ts_iso:           new Date(m.ts).toISOString(),
      from_username:    m.username,
      text:             m.text,
      quoted_text:      m.quotedText     || "",
      quoted_username:  m.quotedUsername || "",
      queued_at:        new Date().toISOString(),
      status:           "pending",
    }));
    existingIds.add(m.id);
  }
  if (newItems.length > 0) fs.appendFileSync(REPLY_QUEUE, newItems.join("\n") + "\n");
  return newItems.length;
}

module.exports = { loadQueuedReplyIds, appendMentionsToReplyQueue, REPLY_QUEUE };
