#!/usr/bin/env node
/**
 * runner/x_amplify.js — autonomous X amplification trigger (the learn-loop's
 * acting end). Scrapes the timeline, scores each candidate by conviction-relevance
 * AND the learned value of its source (lib/amplify_performance), lets the bandit
 * pick what to amplify (explore/exploit), reposts it, and tags the amplification
 * so amplify_measure can later score what it earned.
 *
 * Bare repost only (the simplest, safest amplification; quote/commentary can layer
 * on later). One amplification per run, ledgered so the same tweet is never
 * re-amplified. Own posts + already-amplified + low-relevance + guarded content
 * are all excluded before the pick.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1,
 *      X_AMPLIFY_MAX (1), X_AMPLIFY_RELEVANCE_MIN (2), X_AMPLIFY_SCRAPE (20).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { HelmStackClient, X } = require("../tools/helmstack-social/src");
const { isXSuppressed } = require("./lib/x_control");
const { loadAxisKeywords, makeScorer } = require("./lib/content_relevance");
const amplify = require("./lib/amplify_performance");
const { logRepost } = require("./posts_log");

const ROOT = path.resolve(__dirname, "..");
const LEDGER = path.join(ROOT, "state", "x_amplified.json");

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX = Number.parseInt(process.env.X_AMPLIFY_MAX || "1", 10);
const RELEVANCE_MIN = Number.parseInt(process.env.X_AMPLIFY_RELEVANCE_MIN || "2", 10);
const SCRAPE = Number.parseInt(process.env.X_AMPLIFY_SCRAPE || "20", 10);
const OWN_HANDLE = "SebastianHunts";
const log = (m) => console.log(`[x_amplify] ${m}`);

function loadLedger() { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, "utf-8")).keys); } catch { return new Set(); } }
function saveLedger(seen) { try { fs.writeFileSync(LEDGER, JSON.stringify({ keys: [...seen].slice(-1000) }, null, 2)); } catch {} }

(async () => {
  if (isXSuppressed("repost")) { log("X amplification suppression active — skipping"); process.exit(0); }

  const x = new X(new HelmStackClient(), { ownHandle: OWN_HANDLE, dedicatedTab: true, log });
  try {
    await x.ensureTab();
    if (!(await x.sessionOk())) { log("X session not present — skipping"); await x.close().catch(() => {}); process.exit(0); }
  } catch (err) { log(`could not reach HelmStack/X: ${err.message}`); process.exit(0); }

  try {
    const seen = loadLedger();
    const keywords = loadAxisKeywords();
    const score = makeScorer(keywords);

    const posts = await x.scrapeTimeline({ limit: SCRAPE, scrolls: 3 });
    log(`scraped ${posts.length} timeline post(s)`);

    // Exclude own posts, already-amplified, and (defensively) empty candidates.
    const fresh = posts.filter((p) => p.url && p.handle
      && p.handle.toLowerCase() !== OWN_HANDLE.toLowerCase()
      && !seen.has(p.tweetId));
    if (!fresh.length) { log("no fresh candidates"); await x.close().catch(() => {}); process.exit(0); }

    // Score relevance (LLM 0-3 + guards). Keep only those clearing the bar.
    const scored = [];
    for (const p of fresh) {
      const s = await score(p);
      if (s >= RELEVANCE_MIN) scored.push({ ...p, relevance: s });
    }
    log(`${scored.length}/${fresh.length} candidate(s) cleared relevance ≥ ${RELEVANCE_MIN}`);
    if (!scored.length) { await x.close().catch(() => {}); process.exit(0); }

    // Bandit pick over sources: force-explore under-sampled, else exploit the
    // source with the best measured amplification engagement. Among candidates
    // sharing the picked source, take the most relevant one.
    const candidates = scored.map((p) => ({ sourceHandle: p.handle, post: p }));
    let amplified = 0;
    for (let i = 0; i < MAX && candidates.length; i++) {
      const choice = amplify.pickAmplifyTarget(candidates);
      if (!choice) break;
      const handle = choice.candidate.sourceHandle;
      // best-relevance post from the chosen source
      const pool = candidates.filter((c) => c.sourceHandle === handle).map((c) => c.post).sort((a, b) => b.relevance - a.relevance);
      const target = pool[0];
      log(`pick: @${handle} (${choice.reason}) — relevance ${target.relevance.toFixed(1)} — ${target.url}`);

      if (DRY_RUN) {
        log(`DRY RUN — would repost ${target.url}`);
      } else {
        const res = await x.retweet(target.url, { dryRun: false });
        if (!res.ok) { log(`repost failed (${res.reason}) — trying next`); }
        else {
          seen.add(target.tweetId);
          const srcUrl = target.url.split("?")[0];
          logRepost({ source_url: srcUrl, source_handle: handle, topic: null });
          amplify.recordAmplification(`repost:${srcUrl}`, { channel: "x", sourceHandle: handle, technique: "repost", sourceUrl: srcUrl, measurable: false });
          log(`amplified @${handle}: ${srcUrl}`);
          amplified++;
        }
      }
      // Drop this source's candidates so a second pick (if MAX>1) diversifies.
      for (let j = candidates.length - 1; j >= 0; j--) if (candidates[j].sourceHandle === handle) candidates.splice(j, 1);
    }

    if (!DRY_RUN) saveLedger(seen);
    const summary = amplify.summaryText();
    if (summary) log("\n" + summary);
    log(`done — ${amplified} amplification(s)${DRY_RUN ? " (dry run)" : ""}`);
  } catch (err) {
    log(`error: ${err.message}`);
  } finally {
    await x.close().catch(() => {});
  }
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
