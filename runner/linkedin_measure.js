#!/usr/bin/env node
/**
 * runner/linkedin_measure.js — measure engagement on Sebastian's LinkedIn posts
 * so the test-and-learn loop (lib/linkedin_performance) can correlate opening
 * technique → engagement. Scrapes reactions + comments for posts old enough to
 * have accrued engagement (default >24h) but not yet measured.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), LI_MEASURE_MAX (6), LI_MEASURE_MIN_AGE_H (24).
 * Non-fatal. Wired into runSocialPipeline (dueForRun).
 */

"use strict";

const { HelmStackClient, LinkedIn } = require("../tools/helmstack-social/src");
const perf = require("./lib/linkedin_performance");

const MAX = Number.parseInt(process.env.LI_MEASURE_MAX || "6", 10);
const MIN_AGE_H = Number.parseInt(process.env.LI_MEASURE_MIN_AGE_H || "24", 10);
const log = (m) => console.log(`[linkedin_measure] ${m}`);

(async () => {
  const due = perf.unmeasured({ olderThanHours: MIN_AGE_H });
  if (!due.length) { log("no posts due for measurement"); process.exit(0); }

  const li = new LinkedIn(new HelmStackClient(), { log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present — skipping"); process.exit(0); }
  } catch (err) { log(`could not reach HelmStack/LinkedIn: ${err.message}`); process.exit(0); }

  let measured = 0;
  for (const p of due.slice(0, MAX)) {
    try {
      const m = await li.scrapePostEngagement(p.url);
      perf.recordMetric(p.url, m);
      log(`${p.technique}: ${m.reactions} reactions + ${m.comments} comments (${m.reactions + m.comments} eng) — ${p.url.slice(-24)}`);
      measured++;
    } catch (e) { log(`measure failed for ${p.url.slice(-24)}: ${e.message}`); }
  }
  log(`done — measured ${measured} post(s)`);
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
