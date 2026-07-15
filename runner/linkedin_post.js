#!/usr/bin/env node
/**
 * runner/linkedin_post.js — hunter adapter: publish a LinkedIn post.
 *
 * Thin wrapper that wires hunter's voice filter + posts_log into the generic
 * `helmstack-social` LinkedIn engine (tools/helmstack-social).
 *
 * Drains the channel-agnostic outbox (lib/outbox): claims the NEWEST pending
 * 'linkedin' item, voice/length-gates it, posts it, and marks the outcome —
 *   posted   → success (url recorded)
 *   rejected → gate failed (permanent; can NEVER block later drafts — the old
 *              single-file deadlock is gone)
 *   failed   → transient post error (retried on a later cycle until max_attempts)
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1.
 * Exit 0 = posted (or dry-run / nothing queued), 1 = transient failure.
 */

"use strict";

const { HelmStackClient, LinkedIn } = require("../tools/helmstack-social/src");
const { logLinkedIn } = require("./posts_log");
const voiceFilter = require("./lib/voice_filter");
const outbox = require("./lib/outbox");
const perf = require("./lib/linkedin_performance");

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX_LEN = 2900;
const tag = "linkedin_post";
const log = (m) => console.log(`[${tag}] ${m}`);

(async () => {
  const item = outbox.claimLatest("linkedin", { kinds: ["post"] });
  if (!item) { log("no pending LinkedIn post in outbox — nothing to do"); process.exit(0); }
  const text = (item.text || "").trim();

  // Content-quality gates are PERMANENT failures → reject (never re-queued),
  // so a bad draft self-clears instead of wedging the queue.
  if (!text) { outbox.markRejected(item.id, "empty"); log(`outbox #${item.id} empty — rejected`); process.exit(0); }
  if (text.length > MAX_LEN) { outbox.markRejected(item.id, "too_long"); log(`outbox #${item.id} too long (${text.length} > ${MAX_LEN}) — rejected`); process.exit(0); }
  const vfErrors = voiceFilter.check(text);
  if (vfErrors.length) { outbox.markRejected(item.id, `voice_filter: ${vfErrors.join("; ")}`); log(`outbox #${item.id} voice_filter rejected: ${vfErrors.join("; ")} — rejected`); process.exit(0); }

  log(`posting outbox #${item.id} (${text.length} chars): ${text.slice(0, 80).replace(/\n/g, " ")}...`);

  const li = new LinkedIn(new HelmStackClient(), { log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present (no li_at) — is HelmStack logged in?"); outbox.markFailed(item.id, "no_session"); process.exit(1); }
  } catch (err) {
    log(`could not reach HelmStack/LinkedIn: ${err.message}`); outbox.markFailed(item.id, `unreachable: ${err.message}`); process.exit(1);
  }

  const res = await li.post(text, { dryRun: DRY_RUN });
  if (res.dryRun) { outbox.markFailed(item.id, "dry_run"); log("DRY RUN complete — not published (item returned to pending)"); process.exit(0); }
  if (!res.posted) { const st = outbox.markFailed(item.id, res.reason || "post_failed"); log(`post failed (${res.reason}) — outbox #${item.id} → ${st}`); process.exit(1); }

  outbox.markPosted(item.id, { url: res.url || null });
  log(`SUCCESS${res.url ? `: ${res.url}` : ""} (outbox #${item.id})`);
  logLinkedIn({ type: "linkedin_post", content: text, url: res.url || "", cycle: CYCLE });
  // Tag the post with its opening technique so linkedin_measure can score it later.
  if (res.url && item.meta && item.meta.technique) { try { perf.recordPost(res.url, item.meta.technique); } catch {} }
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(1); });
