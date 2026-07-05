#!/usr/bin/env node
/**
 * runner/linkedin_post.js — hunter adapter: publish a LinkedIn post.
 *
 * Thin wrapper that wires hunter's voice filter + posts_log into the generic
 * `helmstack-social` LinkedIn engine (tools/helmstack-social).
 *
 * Reads state/linkedin_draft.txt (or $DRAFT_FILE). First line "SKIP" = skip.
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1, DRAFT_FILE.
 * Exit 0 = posted (or dry-run), 1 = failed/skipped.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { HelmStackClient, LinkedIn } = require("../tools/helmstack-social/src");
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
const log = (m) => console.log(`[${tag}] ${m}`);

(async () => {
  if (!fs.existsSync(DRAFT_FILE)) { log(`no ${path.basename(DRAFT_FILE)} — nothing to post`); process.exit(1); }
  const text = fs.readFileSync(DRAFT_FILE, "utf-8").trim();
  if (!text || text === "SKIP") { log("draft empty or SKIP — skipping"); process.exit(1); }
  if (text.length > MAX_LEN) { log(`draft too long (${text.length} > ${MAX_LEN})`); process.exit(1); }

  const vfErrors = voiceFilter.check(text);
  if (vfErrors.length) { log(`voice_filter rejected: ${vfErrors.join("; ")}`); process.exit(1); }

  log(`posting (${text.length} chars): ${text.slice(0, 80).replace(/\n/g, " ")}...`);

  const li = new LinkedIn(new HelmStackClient(), { log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present (no li_at) — is HelmStack logged in?"); process.exit(1); }
  } catch (err) {
    log(`could not reach HelmStack/LinkedIn: ${err.message}`); process.exit(1);
  }

  const res = await li.post(text, { dryRun: DRY_RUN });
  if (res.dryRun) { log("DRY RUN complete — not published"); process.exit(0); }
  if (!res.posted) { log(`post failed (${res.reason}) — leaving draft for retry`); process.exit(1); }

  log(`SUCCESS${res.url ? `: ${res.url}` : ""}`);
  logLinkedIn({ type: "linkedin_post", content: text, url: res.url || "", cycle: CYCLE });
  try { fs.unlinkSync(DRAFT_FILE); } catch {}
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(1); });
