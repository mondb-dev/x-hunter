#!/usr/bin/env node
"use strict";
/**
 * runner/linkedin_reply.js — inbound LinkedIn responder (mirror of the X reply path).
 *
 * Scrapes notifications directed AT Sebastian (mentions, comments on his posts,
 * replies), composes an on-voice, fact-checked reply — optionally grounded in a
 * fast flat-tier deep-research pass — and posts it via the notification's comment
 * box. Dedupes via a ledger, honors per-run/per-day caps.
 *
 * SAFETY: dry-run by DEFAULT (composes + verifies the editor, does NOT post).
 * Set LINKEDIN_REPLY_LIVE=1 to actually post.
 *
 * Env: HELMSTACK_AUTH_TOKEN (req), LINKEDIN_REPLY_LIVE=1, LINKEDIN_REPLY_RESEARCH=1,
 *      LI_REPLY_MAX (2/run), LI_REPLY_MAX_DAY (8).
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const { HelmStackClient, LinkedIn } = require("../tools/helmstack-social/src");
const { compose } = require("./lib/compose");
const { passOutbound } = require("./lib/outbound_gates");
let logLinkedIn = () => {}; try { ({ logLinkedIn } = require("./posts_log")); } catch {}

const LEDGER = path.join(ROOT, "state", "linkedin_replied.json");
const LIVE = process.env.LINKEDIN_REPLY_LIVE === "1";
const USE_RESEARCH = process.env.LINKEDIN_REPLY_RESEARCH === "1";
const MAX_PER_RUN = Number(process.env.LI_REPLY_MAX || "2");
const MAX_PER_DAY = Number(process.env.LI_REPLY_MAX_DAY || "8");
const log = (m) => console.log(`[linkedin_reply] ${m}`);

function today() { return new Date().toISOString().slice(0, 10); }
function loadLedger() {
  try { const l = JSON.parse(fs.readFileSync(LEDGER, "utf-8")); if (l.day !== today()) { l.day = today(); l.count = 0; } if (!Array.isArray(l.ids)) l.ids = []; return l; }
  catch { return { day: today(), count: 0, ids: [] }; }
}
function saveLedger(l) { try { l.ids = l.ids.slice(-500); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); } catch {} }

// Strip the "X mentioned you in a comment." lead-in → the actual comment content.
function extractContent(text) {
  return String(text || "")
    .replace(/^.*?(?:mentioned you in a comment|commented on (?:your|this)[^.]*|replied to (?:your|you)[^.]*)\.?\s*/i, "")
    .trim();
}

async function composeReply(item) {
  const content = extractContent(item.text) || String(item.text || "");
  let researchBlock = "";
  if (USE_RESEARCH && content.length > 12) {
    try {
      const { deepResearch } = require("./deep_research");
      const r = await deepResearch(content.slice(0, 300), { tier: "standard", maxFetch: 2 });
      if (r && r.report && !r.bailed) researchBlock = `\n\nRESEARCH (draw only on what's relevant, weave in specifics naturally):\n${r.report.slice(0, 1500)}`;
    } catch (e) { log(`research enrich failed (non-fatal): ${e.message}`); }
  }
  const kind = item.type === "mention" ? "mentioned you" : item.type === "comment" ? "commented on your post" : "replied to your comment";
  const prompt =
`You are Sebastian Hunter replying on LinkedIn (a professional network — analytical, credible, substantive; NOT an X-style hot take). ${item.actor || "Someone"} ${kind}:
"""
${content.slice(0, 1200)}
"""
Write a thoughtful reply (2-5 sentences) that adds a SPECIFIC, grounded point — name a concrete claim, mechanism, number, or example; engage what they actually said. First person, direct. No filler ("great question"), no hashtags, no emojis, no tool/system names. If there's nothing worth adding, return SKIP.${researchBlock}
Reply text only:`;
  const raw = await compose(prompt, { maxTokens: 400, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "linkedin_reply" });
  const gated = await passOutbound(raw, { gates: ["voice", "factcheck"], maxLen: 600, tag: "linkedin_reply" });
  if (!gated.ok) { log(`gate rejected: ${gated.reason}`); return null; }
  return gated.text;
}

(async () => {
  log(`starting (${LIVE ? "LIVE" : "DRY-RUN"}${USE_RESEARCH ? " +research" : ""})`);
  const li = new LinkedIn(new HelmStackClient(), { ownHandleHint: "sebastian hunter", log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present (no li_at) — is HelmStack logged in?"); process.exit(0); }
  } catch (e) { log(`could not reach HelmStack/LinkedIn: ${e.message}`); process.exit(0); }

  const notifs = await li.scrapeNotifications({ limit: 20 });
  log(`scraped ${notifs.length} actionable notification(s)`);
  const ledger = loadLedger();
  const seen = new Set(ledger.ids);
  const pending = notifs.filter((n) => n.id && !seen.has(n.id) && n.href);
  log(`${pending.length} new (after dedup); ${ledger.count}/${MAX_PER_DAY} replied today`);

  let done = 0;
  for (const item of pending) {
    if (done >= MAX_PER_RUN || ledger.count >= MAX_PER_DAY) break;
    log(`[${item.type}] @${item.actor}: "${extractContent(item.text).slice(0, 80)}"`);
    let reply;
    try { reply = await composeReply(item); } catch (e) { log(`compose failed: ${e.message}`); reply = null; }
    if (!reply) { seen.add(item.id); ledger.ids.push(item.id); continue; }  // ledger it so we don't retry a SKIP forever
    log(`  draft: "${reply.slice(0, 160)}"`);
    const res = await li.replyToNotification(item.href, reply, { dryRun: !LIVE, type: item.type });
    if (res.dryRun) { log(`  DRY-RUN — editor found + text verified, not posted.`); done++; continue; }  // don't ledger — let a later LIVE run actually reply
    if (res.ok) {
      log(`  posted ✓`);
      try { logLinkedIn({ type: "linkedin_comment", content: reply, target_author: item.actor, target_url: item.href }); } catch {}
      done++; ledger.count++; seen.add(item.id); ledger.ids.push(item.id);
    } else {
      log(`  reply failed: ${res.reason}`);   // do NOT ledger — retry next run
    }
  }
  saveLedger(ledger);
  log(`done. ${LIVE ? "replied" : "dry-ran"} ${done} this run.`);
  process.exit(0);
})().catch((e) => { console.error(`[linkedin_reply] fatal: ${e.message}`); process.exit(1); });
