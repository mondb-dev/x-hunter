#!/usr/bin/env node
/**
 * runner/stance_article.js — long-form article on a stance he chose to write about.
 *
 * Companion to runner/stance_video.js: the same stance can earn a piece to
 * camera, an article, both, or (usually) neither. The judgement is NOT made
 * here — Sebastian makes it himself in stance_scan's reflect pass, which sets
 * media.article.wanted on the stance. This tool only executes that decision, so
 * nothing is written unless he asked for it, and markMediaDone means nothing is
 * written twice.
 *
 * Subject: the newest OPEN stance with media.article.wanted === true and no
 * done_at (override with --stance=<id>).
 *
 * The piece is researched and composed by the shared deep-research pipeline:
 *   - RESEARCH runs on the stance's own question, with triage left ON — his own
 *     quality gates stay in force; a bail means no article, not a bypass.
 *   - The ARTICLE is composed to argue the side + rationale he committed to, so
 *     the thesis is his, not the researcher's.
 * Publishing goes through the same confidence + voice/fact-check gates as
 * anything else he says in public, then lib/post_x_helmstack runArticle (which
 * logs to posts_log). Requires X Premium on the account.
 *
 * Gate: STANCE_ARTICLE_ENABLED != 0. Invoked daily from the orchestrator,
 * detached; non-fatal (exits 0 on any error).
 *
 * Usage: node runner/stance_article.js [--dry-run] [--stance=<id>]
 */

"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DRY = process.argv.includes("--dry-run");
const STANCE_ARG = (process.argv.find((a) => a.startsWith("--stance=")) || "").split("=")[1] || "";

const log = (m) => console.log(`[stance_article] ${m}`);

const watchdog = setTimeout(() => {
  console.error("[stance_article] watchdog: 25 min elapsed — exiting");
  process.exit(1);
}, 25 * 60 * 1000);

async function run() {
  if (process.env.STANCE_ARTICLE_ENABLED === "0") { log("disabled (STANCE_ARTICLE_ENABLED=0)"); return; }

  const stances = require("./lib/stances");
  const queue = stances.pendingMedia("article")
    .sort((a, b) => String(b.taken_at || "").localeCompare(String(a.taken_at || "")));
  const s = STANCE_ARG ? queue.find((x) => x.id === STANCE_ARG) || null : queue[0] || null;
  if (!s) { log("no stance he asked to write about — nothing to do"); return; }

  const why = ((s.media || {}).article || {}).why || "(no reason recorded)";
  log(`his call on "${s.event}" (position ${s.position}): ${why}`);

  const { deepResearch, researchToArticle } = require("./deep_research");

  // Research his own question. triage stays ON — if his own pipeline says the
  // question is underspecified, that is an answer, not an obstacle to route around.
  const res = await deepResearch(s.question, { maxFetch: 6, allowTree: true, maxVerify: 3 });
  if (res.bailed) { log(`research bailed (${String(res.clarify || "triage").slice(0, 120)}) — no article`); return; }

  // Compose to argue the position he actually committed to, in his own words.
  const argue =
`${s.question}

Sebastian Hunter holds a committed, researched stance here (position ${s.position} on a spectrum where negative = "${s.pole_a}" and positive = "${s.pole_b}"): ${s.side}.
His reasoning: "${s.rationale || ""}"

Write his long-form article arguing and evidencing THAT position from the verified record.`;

  const r = await researchToArticle(argue, { _res: res, live: !DRY });

  if (r.bailed) { log("article bailed — nothing published"); return; }
  if (r.gated) { log(`withheld by the confidence gate (${r.confidence != null ? r.confidence + "%" : "?"}) — nothing published`); return; }
  if (!r.title) { log(`no usable draft (${r.reason || "compose failed"})`); return; }
  if (DRY || r.dryRun) { log(`DRY RUN — "${r.title}" (${(r.body || "").length} chars) composed, not publishing`); return; }
  if (!r.posted) { log(`publish failed (${r.reason || "unknown"})`); return; }

  stances.markMediaDone(s.id, "article", { url: r.url || null });
  log(`published on "${s.event}": ${r.url || "(url uncaptured)"}`);
}

run()
  .then(() => { clearTimeout(watchdog); process.exit(0); })
  .catch((e) => { log(`error (non-fatal): ${e.message}`); clearTimeout(watchdog); process.exit(0); });
