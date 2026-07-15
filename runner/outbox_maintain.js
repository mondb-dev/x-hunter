#!/usr/bin/env node
/**
 * runner/outbox_maintain.js — periodic maintenance for the outbound queue
 * (lib/outbox). Two jobs, both cheap:
 *   1. Age out pending drafts older than OUTBOX_STALE_HOURS (default 48) — LIFO
 *      means only the newest pending per channel ever posts, so stragglers would
 *      otherwise linger; mark them 'stale'.
 *   2. Delete terminal rows (posted/rejected/failed/stale) older than
 *      OUTBOX_RETAIN_DAYS (default 14) so the table stays small.
 *
 * Wired into the orchestrator (dueForRun('outbox_maintain', 24h)); also runnable
 * by hand. Never throws fatally — maintenance must not take down a cycle.
 */

"use strict";

const outbox = require("./lib/outbox");

const STALE_HOURS = Number.parseInt(process.env.OUTBOX_STALE_HOURS || "48", 10);
const RETAIN_DAYS = Number.parseInt(process.env.OUTBOX_RETAIN_DAYS || "14", 10);
const log = (m) => console.log(`[outbox_maintain] ${m}`);

try {
  const staled = outbox.staleOldPending({ olderThanHours: STALE_HOURS });
  const deleted = outbox.cleanup({ olderThanDays: RETAIN_DAYS });
  log(`staled ${staled} old pending, deleted ${deleted} terminal (>${RETAIN_DAYS}d); stats ${JSON.stringify(outbox.stats())}`);
  process.exit(0);
} catch (err) {
  log(`error: ${err.message}`);
  process.exit(0);
}
