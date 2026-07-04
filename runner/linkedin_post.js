#!/usr/bin/env node
/**
 * runner/linkedin_post.js — publish a LinkedIn post from a draft
 *
 * Reads the post text from state/linkedin_draft.txt (or $DRAFT_FILE), runs it
 * through the shared voice filter, publishes it via the HelmStack LinkedIn
 * engine, and logs to posts_log.json as type "linkedin_post".
 *
 * Draft format: plain text. First line "SKIP" (alone) = agent chose not to post.
 * LinkedIn allows long-form (up to ~3000 chars) — no 280 cap.
 *
 * Env:
 *   HELMSTACK_AUTH_TOKEN   required (HelmStack API bearer)
 *   HELMSTACK_DRY_RUN=1    stage the post but do not click Post
 *   DRAFT_FILE             override draft path (relative to project root)
 *
 * Exit 0 = posted (or dry-run ok), exit 1 = failed / skipped.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const li = require("./lib/linkedin");
const { logLinkedIn } = require("./posts_log");
const voiceFilter = require("./lib/voice_filter");

const ROOT = path.resolve(__dirname, "..");
const DRAFT_FILE = process.env.DRAFT_FILE
  ? path.resolve(ROOT, process.env.DRAFT_FILE)
  : path.join(ROOT, "state", "linkedin_draft.txt");
const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX_LEN = 2900;

const tag = "linkedin_post";

(async () => {
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error(`[${tag}] no ${path.basename(DRAFT_FILE)} — nothing to post`);
    process.exit(1);
  }
  const text = fs.readFileSync(DRAFT_FILE, "utf-8").trim();
  if (!text || text === "SKIP") {
    console.error(`[${tag}] draft empty or SKIP — skipping`);
    process.exit(1);
  }
  if (text.length > MAX_LEN) {
    console.error(`[${tag}] draft too long (${text.length} > ${MAX_LEN})`);
    process.exit(1);
  }
  // Voice filter (same guard X posts use)
  const vfErrors = voiceFilter.check(text);
  if (vfErrors.length > 0) {
    console.error(`[${tag}] voice_filter rejected draft: ${vfErrors.join("; ")}`);
    process.exit(1);
  }

  console.log(`[${tag}] posting (${text.length} chars): ${text.slice(0, 80).replace(/\n/g, " ")}...`);

  let tab;
  try {
    await li.ensureTab().then((t) => (tab = t));
    if (!(await li.sessionOk(tab))) {
      console.error(`[${tag}] LinkedIn session not present (no li_at cookie) — is HelmStack logged in?`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[${tag}] could not reach HelmStack/LinkedIn: ${err.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = await li.post(tab, text, { dryRun: DRY_RUN, tag });
  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    process.exit(1);
  }

  if (result.dryRun) {
    console.log(`[${tag}] DRY RUN complete — draft verified in composer, not published`);
    process.exit(0);
  }
  if (!result.posted) {
    console.error(`[${tag}] post failed (${result.reason}) — leaving draft for retry`);
    process.exit(1);
  }

  console.log(`[${tag}] SUCCESS — posted to LinkedIn${result.url ? `: ${result.url}` : ""}`);
  logLinkedIn({ type: "linkedin_post", content: text, url: result.url || "", cycle: CYCLE });
  try { fs.unlinkSync(DRAFT_FILE); } catch {}
  process.exit(0);
})().catch((err) => {
  console.error(`[${tag}] fatal: ${err.message}`);
  process.exit(1);
});
