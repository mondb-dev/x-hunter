#!/usr/bin/env node
/**
 * runner/amplify_measure.js — measure engagement on Sebastian's AMPLIFICATIONS
 * (X quotes, LinkedIn reshares-with-commentary) so the amplification learn-loop
 * (lib/amplify_performance) can correlate source/topic → engagement and bias what
 * gets amplified next. Scrapes reactions + comments for amplifications old enough
 * to have accrued engagement (default >24h) but not yet measured.
 *
 * Bare reposts/reshares are tagged measurable:false at publish time (no own
 * engagement surface), so they never appear here — only own-post amplifications do.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), AMPLIFY_MEASURE_MAX (8),
 *      AMPLIFY_MEASURE_MIN_AGE_H (24). Non-fatal.
 */

"use strict";

const { HelmStackClient, X, LinkedIn } = require("../tools/helmstack-social/src");
const perf = require("./lib/amplify_performance");
const { HANDLE } = require("./post_result");

const MAX = Number.parseInt(process.env.AMPLIFY_MEASURE_MAX || "8", 10);
const MIN_AGE_H = Number.parseInt(process.env.AMPLIFY_MEASURE_MIN_AGE_H || "24", 10);
const log = (m) => console.log(`[amplify_measure] ${m}`);

(async () => {
  const due = perf.unmeasured({ olderThanHours: MIN_AGE_H }).slice(0, MAX);
  if (!due.length) { log("no amplifications due for measurement"); process.exit(0); }

  const byChannel = { x: due.filter((d) => d.channel === "x"), linkedin: due.filter((d) => d.channel === "linkedin") };
  log(`due: ${byChannel.x.length} x, ${byChannel.linkedin.length} linkedin`);

  const client = new HelmStackClient();
  try { await client.health(); } catch (e) { log(`HelmStack unreachable: ${e.message} — skipping`); process.exit(0); }

  let measured = 0;

  // X quotes — scrape the quote tweet's own engagement.
  if (byChannel.x.length) {
    const x = new X(client, { ownHandle: HANDLE, dedicatedTab: true, log });
    try {
      await x.ensureTab();
      if (await x.sessionOk()) {
        for (const d of byChannel.x) {
          try {
            const m = await x.scrapeTweetEngagement(d.url);
            perf.recordMetric(d.url, m);
            log(`x/${d.technique} @${d.source_handle}: ${m.reactions} likes + ${m.comments} replies (${m.reactions + m.comments} eng) — ${d.url.slice(-20)}`);
            measured++;
          } catch (e) { log(`x measure failed ${d.url.slice(-20)}: ${e.message}`); }
        }
      } else { log("X session not present — skipping x amplifications"); }
    } catch (e) { log(`x engine error: ${e.message}`); }
    finally { try { await x.close(); } catch {} }
  }

  // LinkedIn reshares (with commentary) — scrape the reshare's engagement.
  if (byChannel.linkedin.length) {
    const li = new LinkedIn(client, { log });
    try {
      await li.ensureTab();
      if (await li.sessionOk()) {
        for (const d of byChannel.linkedin) {
          try {
            const m = await li.scrapePostEngagement(d.url);
            perf.recordMetric(d.url, m);
            log(`linkedin/${d.technique} @${d.source_handle}: ${m.reactions} reactions + ${m.comments} comments (${m.reactions + m.comments} eng) — ${d.url.slice(-24)}`);
            measured++;
          } catch (e) { log(`linkedin measure failed ${d.url.slice(-24)}: ${e.message}`); }
        }
      } else { log("LinkedIn session not present — skipping linkedin amplifications"); }
    } catch (e) { log(`linkedin engine error: ${e.message}`); }
  }

  const top = perf.summaryText();
  if (top) log("\n" + top);
  log(`done — measured ${measured} amplification(s)`);
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
