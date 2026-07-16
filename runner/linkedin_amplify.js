#!/usr/bin/env node
/**
 * runner/linkedin_amplify.js — autonomous LinkedIn amplification trigger, the
 * parallel of runner/x_amplify.js. Scrapes the feed, scores each candidate by
 * conviction-relevance AND the learned value of its source (lib/amplify_performance),
 * lets the bandit pick, reshares it (UI-driven — see LinkedIn.reshare), reads the
 * reshare's own permalink back from recent activity, and tags the amplification so
 * amplify_measure can score what it earned.
 *
 * One reshare per run, ledgered so the same post is never re-amplified. Own posts
 * are filtered by scrapeFeed; already-amplified / low-relevance / guarded content
 * are excluded before the pick.
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1,
 *      LI_AMPLIFY_RELEVANCE_MIN (2), LI_AMPLIFY_SCRAPE (10).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { HelmStackClient, LinkedIn } = require("../tools/helmstack-social/src");
const { isSensitiveContent, isSatireOrJoke } = require("./lib/content_relevance");
const amplify = require("./lib/amplify_performance");
const { logLinkedIn } = require("./posts_log");

const ROOT = path.resolve(__dirname, "..");
const LEDGER = path.join(ROOT, "state", "li_amplified.json");
const PROFILE = "https://www.linkedin.com/in/sebastian-hunter-aa0b5241b/";

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const RELEVANCE_MIN = Number.parseInt(process.env.LI_AMPLIFY_RELEVANCE_MIN || "2", 10);
const SCRAPE = Number.parseInt(process.env.LI_AMPLIFY_SCRAPE || "10", 10);
const log = (m) => console.log(`[linkedin_amplify] ${m}`);

function loadLedger() { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, "utf-8")).keys); } catch { return new Set(); } }
function saveLedger(seen) { try { fs.writeFileSync(LEDGER, JSON.stringify({ keys: [...seen].slice(-1000) }, null, 2)); } catch {} }

// scrapeFeed's author field is empty against LinkedIn's current obfuscated DOM,
// but the scraped text embeds the actor name after the feed-card chrome, e.g.
// "Feed post number 2 Recommended for you Sayash Kapoor • 3rd+ …" or
// "Feed post Rizza Camingawan reposted this Jay Tarriela • 3rd+ …" (the reshared
// author). Parse it out as the amplify arm; empty if unrecognizable.
function parseAuthor(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^Feed post( number \d+)?\s*/i, "");
  t = t.replace(/^(Recommended for you|Promoted|.*? reposted this|.*? likes this|.*? loves this|.*? celebrates this|.*? commented on this|.*? follows)\s+/i, "");
  const m = t.match(/^(.{2,60}?)\s*•/);
  return m ? m[1].trim() : "";
}

// LinkedIn-tuned relevance scorer (shared guards + local-brain 0-3 rating).
function makeScorer() {
  const { generate: llmGenerate } = require("./llm");
  return async (post) => {
    const text = (post.text || "").trim();
    if (!text) return -1;
    if (isSensitiveContent(text) || isSatireOrJoke(text)) return -1;
    try {
      const raw = await llmGenerate(
        `You rate LinkedIn posts for Sebastian Hunter, who analyzes how narratives are constructed in public discourse: political messaging, media framing, propaganda, institutional accountability, information integrity.\n\n` +
        `Rate ONLY substantive relevance to those themes. Job updates, congratulations, motivational quotes, personal milestones, generic business advice, and ads = 0 even if well-written. A post must actually engage with power, politics, media, policy, or truth-claims to score 2-3.\n\n` +
        `Answer with a SINGLE digit:\n0 = irrelevant, 1 = tangential, 2 = relevant, 3 = squarely on-topic.\n\n` +
        `POST: "${text.slice(0, 400)}"\n\nDigit:`,
        { temperature: 0, maxTokens: 5, timeoutMs: 30_000 }
      );
      const m = String(raw).match(/[0-3]/);
      return m ? Number(m[0]) : 0;
    } catch { return 0; }
  };
}

(async () => {
  const li = new LinkedIn(new HelmStackClient(), { ownHandleHint: "sebastian hunter", log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present — skipping"); process.exit(0); }
  } catch (err) { log(`could not reach HelmStack/LinkedIn: ${err.message}`); process.exit(0); }

  try {
    const seen = loadLedger();
    const score = makeScorer();

    const posts = await li.scrapeFeed({ limit: SCRAPE });
    log(`scraped ${posts.length} feed post(s)`);

    // reshare() works by data-hs-idx, so a permalink is NOT required to act —
    // scrapeFeed exposes one for only some posts. Use the permalink as the dedup
    // key when present, else a stable author+text fallback. Own posts are already
    // dropped by scrapeFeed's ownHandleHint filter.
    const authorOf = (p) => (p.author || "").trim() || parseAuthor(p.text);
    const dedupKey = (p) => p.permalink || ("li:" + authorOf(p) + ":" + (p.text || "").replace(/\s+/g, " ").trim().slice(0, 40));
    const fresh = posts.filter((p) => authorOf(p) && (p.text || "").trim() && !seen.has(dedupKey(p)));
    if (!fresh.length) { log("no fresh candidates"); process.exit(0); }

    const scored = [];
    for (const p of fresh) {
      const s = await score(p);
      if (s >= RELEVANCE_MIN) scored.push({ ...p, relevance: s });
    }
    log(`${scored.length}/${fresh.length} candidate(s) cleared relevance ≥ ${RELEVANCE_MIN}`);
    if (!scored.length) { process.exit(0); }

    // Bandit pick over sources (author names), then the most relevant post from
    // the chosen source.
    const candidates = scored.map((p) => ({ sourceHandle: authorOf(p), post: p }));
    const choice = amplify.pickAmplifyTarget(candidates);
    if (!choice) { log("no pick"); process.exit(0); }
    const author = choice.candidate.sourceHandle;
    const target = candidates.filter((c) => c.sourceHandle === author).map((c) => c.post).sort((a, b) => b.relevance - a.relevance)[0];
    log(`pick: ${author} (${choice.reason}) — relevance ${target.relevance.toFixed(1)} — ${target.permalink}`);

    if (DRY_RUN) {
      const dry = await li.reshare(target.idx, { dryRun: true });
      log(`DRY RUN — reshare check: ${JSON.stringify(dry)}`);
      process.exit(0);
    }

    const res = await li.reshare(target.idx);
    if (!res.ok) { log(`reshare failed (${res.reason})`); process.exit(0); }
    seen.add(dedupKey(target));
    saveLedger(seen);

    // Read the reshare's own permalink back (best-effort) so it's measurable.
    // Match on the AUTHOR — it appears in the recent-activity reshare header
    // ("Sebastian Hunter reposted this <author>"), unlike the feed-card chrome.
    let reshareUrl = null;
    try { reshareUrl = await li.latestReshareUrl(PROFILE, author); } catch (e) { log(`reshare-url read failed: ${e.message}`); }

    const ourUrl = reshareUrl || `reshare:${target.permalink}`;
    amplify.recordAmplification(ourUrl, { channel: "linkedin", sourceHandle: author, technique: "reshare", sourceUrl: target.permalink, measurable: !!reshareUrl });
    logLinkedIn({ type: "linkedin_reshare", content: "", target_author: author, target_url: target.permalink, cycle: CYCLE });
    log(`amplified ${author}: ${target.permalink}${reshareUrl ? ` → ${reshareUrl}` : " (url not captured — tagged non-measurable)"}`);

    const summary = amplify.summaryText();
    if (summary) log("\n" + summary);
  } catch (err) {
    log(`error: ${err.message}`);
  }
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
