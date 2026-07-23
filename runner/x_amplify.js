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
const { logRepost, logQuote } = require("./posts_log");

const ROOT = path.resolve(__dirname, "..");
const LEDGER = path.join(ROOT, "state", "x_amplified.json");

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX = Number.parseInt(process.env.X_AMPLIFY_MAX || "1", 10);
const RELEVANCE_MIN = Number.parseInt(process.env.X_AMPLIFY_RELEVANCE_MIN || "2", 10);
const SCRAPE = Number.parseInt(process.env.X_AMPLIFY_SCRAPE || "20", 10);
// Quote-with-commentary is a richer, MEASURABLE amplification (its own tweet earns
// engagement) but heavier (an LLM compose + gates), so it's used only for squarely
// on-topic posts and only some of the time; otherwise a bare repost. QUOTE_PROB=0
// disables quoting entirely (always bare repost).
const QUOTE_MIN_RELEVANCE = Number.parseInt(process.env.X_AMPLIFY_QUOTE_MIN_RELEVANCE || "3", 10);
const QUOTE_PROB = Number.parseFloat(process.env.X_AMPLIFY_QUOTE_PROB || "0.4");
const OWN_HANDLE = "SebastianHunts";
const log = (m) => console.log(`[x_amplify] ${m}`);

function loadLedger() { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, "utf-8")).keys); } catch { return new Set(); } }
function saveLedger(seen) { try { fs.writeFileSync(LEDGER, JSON.stringify({ keys: [...seen].slice(-1000) }, null, 2)); } catch {} }

// Compose short on-voice commentary for a quote-tweet amplification (gated by
// voice_filter + fact-check). Returns the text or null (→ caller bare-reposts).
async function composeCommentary(post) {
  const { compose } = require("./lib/compose");
  const { passOutbound } = require("./lib/outbound_gates");
  let persona = "";
  try {
    const { buildPersona, buildCoreContext } = require("./lib/sebastian_respond");
    persona = buildPersona("reply") + "\n\n" + buildCoreContext({ maxAxes: 6, journalCount: 1, journalChars: 300, includeClaims: true });
  } catch { persona = "You are Sebastian Hunter, mapping how narratives are constructed in public discourse. Direct, specific, evidence-first."; }

  const prompt = persona +
    `\n\nCURRENT DATE: ${new Date().toISOString().slice(0, 10)}. Do not rely on training data for current officeholders.\n` +
    `\nYou are QUOTE-TWEETING this post by @${post.handle} to amplify it with your own sharp framing (the original is attached below the quote, so don't restate it):\n"""\n${(post.text || "").slice(0, 500)}\n"""\n\n` +
    `Write a single quote-tweet comment (max 240 chars) that adds ONE specific angle — the pattern it fits, the tension it exposes, the number/actor that matters. Direct and confident; no "interesting", no hedging; don't start with "I". If you can't add something genuinely worth saying, return SKIP.\n\nReturn ONLY the comment text.`;

  try {
    const raw = await compose(prompt, { maxTokens: 300, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "x_amplify_quote" });
    // `source` enables the coherence gate (does the commentary understand the
    // post it quotes?); `regenerate` re-drafts a misread rather than dropping it.
    const gated = await passOutbound(raw, {
      gates: ["voice", "factcheck"], maxLen: 240, tag: "x_amplify_quote",
      source: post.text || "",
      regenerate: async (why) => compose(
        prompt + `\n\nYOUR PREVIOUS DRAFT MISREAD THE POST — ${why}. Re-read it: get WHO did WHAT to WHOM right and do not invent a contradiction. Write a corrected comment, or return SKIP.`,
        { maxTokens: 300, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "x_amplify_quote" }
      ),
    });
    if (!gated.ok) { log(`quote commentary gate rejected: ${gated.reason}`); return null; }
    if (gated.coherence) log(`coherence flag @${post.handle}: ${gated.coherence.why}`);
    return gated.text;
  } catch (e) { log(`quote commentary failed: ${e.message}`); return null; }
}

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
      const srcUrl = target.url.split("?")[0];

      // Technique: quote-with-commentary for squarely-on-topic posts, sometimes;
      // else a bare repost. Quote needs the 'quote' suppression to be off.
      const wantQuote = QUOTE_PROB > 0 && target.relevance >= QUOTE_MIN_RELEVANCE
        && Math.random() < QUOTE_PROB && !isXSuppressed("quote");
      log(`pick: @${handle} (${choice.reason}) — relevance ${target.relevance.toFixed(1)} — ${wantQuote ? "quote" : "repost"} — ${target.url}`);

      if (DRY_RUN) {
        log(`DRY RUN — would ${wantQuote ? "quote" : "repost"} ${target.url}`);
        for (let j = candidates.length - 1; j >= 0; j--) if (candidates[j].sourceHandle === handle) candidates.splice(j, 1);
        continue;
      }

      // Try the quote path first if selected; fall back to bare repost if the
      // commentary can't be composed/gated or the quote fails to post.
      let done = false;
      if (wantQuote) {
        const commentary = await composeCommentary(target);
        if (commentary) {
          const q = await x.quote(srcUrl, commentary, { dryRun: false, skipIfMentions: [OWN_HANDLE] });
          if (q.posted && q.url) {
            seen.add(target.tweetId);
            logQuote({ content: commentary, source_url: srcUrl, tweet_url: q.url, cycle: CYCLE });
            amplify.recordAmplification(q.url, { channel: "x", sourceHandle: handle, technique: "quote", sourceUrl: srcUrl, measurable: true });
            log(`amplified (quote) @${handle}: ${q.url}`);
            amplified++; done = true;
          } else { log(`quote failed (${q.reason || "no_url"}) — falling back to repost`); }
        } else { log("no commentary — falling back to repost"); }
      }
      if (!done) {
        const res = await x.retweet(target.url, { dryRun: false });
        if (!res.ok) { log(`repost failed (${res.reason}) — trying next`); }
        else {
          seen.add(target.tweetId);
          logRepost({ source_url: srcUrl, source_handle: handle, topic: null });
          amplify.recordAmplification(`repost:${srcUrl}`, { channel: "x", sourceHandle: handle, technique: "repost", sourceUrl: srcUrl, measurable: false });
          log(`amplified (repost) @${handle}: ${srcUrl}`);
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
