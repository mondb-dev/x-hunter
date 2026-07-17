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

  // Optional image: if the draft carried a source URL (meta.image_source), copy
  // that source's og:image and post it via LinkedIn's media pipeline with a
  // "📷 via <source>" line. The temp image is ALWAYS deleted afterward.
  let res, tmpImg = null, postedWithImage = false;
  const sourceUrl = item.meta && item.meta.image_source;
  try {
    if (sourceUrl && !DRY_RUN) {
      const si = require("./lib/source_image");
      const img = await si.fetchSourceImage(sourceUrl);
      if (img) {
        tmpImg = img.path;
        log(`attaching source image from ${img.source}`);
        res = await li.postImage(`${text}\n\n${si.attribution(img.source)}`, img.path, { dryRun: DRY_RUN });
        postedWithImage = !!(res && res.posted);
      } else { log("no og:image at source — posting text only"); }
    }
    if (!res) res = await li.post(text, { dryRun: DRY_RUN });
  } finally {
    if (tmpImg) { try { require("./lib/source_image").cleanup(tmpImg); } catch {} }
  }
  if (res.dryRun) { outbox.markFailed(item.id, "dry_run"); log("DRY RUN complete — not published (item returned to pending)"); process.exit(0); }
  if (!res.posted) { const st = outbox.markFailed(item.id, res.reason || "post_failed"); log(`post failed (${res.reason}) — outbox #${item.id} → ${st}`); process.exit(1); }

  outbox.markPosted(item.id, { url: res.url || null });
  log(`SUCCESS${res.url ? `: ${res.url}` : ""} (outbox #${item.id})`);
  logLinkedIn({ type: "linkedin_post", content: text, url: res.url || "", cycle: CYCLE });
  // Tag the post with the shape ACTUALLY published (image fetch can fall back to
  // text-only; ending/length are derived from the final text) so the A/B loop
  // (linkedin_measure → lib/linkedin_performance) scores real cells, not intent.
  if (res.url) {
    try {
      const meta = item.meta || {};
      perf.recordPost(res.url, {
        technique: meta.technique,
        ending: /\?\s*$/.test(text.trim()) ? "question" : (meta.ending || "claim"),
        length: perf.lengthBucket(text.split(/\s+/).filter(Boolean).length),
        media: postedWithImage ? "image" : (meta.link_source ? "link" : "none"),
      });
    } catch {}
  }
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(1); });
