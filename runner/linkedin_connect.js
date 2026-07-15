#!/usr/bin/env node
/**
 * runner/linkedin_connect.js — hunter adapter: grow Sebastian's LinkedIn network
 * by reaching out to niche-relevant people (connect where LinkedIn offers it,
 * else follow).
 *
 * Flow: rotate to the next niche query (lib/linkedin_connect_queries) → People
 * search via the helmstack-social LinkedIn engine → keep un-contacted, on-mission
 * results → for each, navigate to the profile and CONNECT with a short
 * personalized note (Claude, voice-gated) where LinkedIn exposes Connect, else
 * FOLLOW. Every action is ledgered (state/linkedin_connected.json) for dedupe +
 * a hard per-DAY cap so repeated cycles never over-reach.
 *
 * PLATFORM REALITY: LinkedIn now steers cold (out-of-network) profiles to Follow
 * and only exposes Connect for warmer ones (shared connections, PYMK). So many
 * niche-search hits become follows, not invites — that's expected, and still
 * grows the network/feed. Set LI_CONNECT_FOLLOW=0 to only ever connect (skip
 * follow-only profiles). LinkedIn's free tier also caps invites-WITH-a-note
 * (~5/week); past that the engine sends the invite blank so it still lands
 * (LI_CONNECT_NOTE=0 forces blank always).
 *
 * Env: HELMSTACK_AUTH_TOKEN (required), HELMSTACK_DRY_RUN=1,
 *      LI_CONNECT_MAX_DAY (10), LI_CONNECT_PER_RUN (5),
 *      LI_CONNECT_RELEVANCE_MIN (2), LI_CONNECT_NOTE (1),
 *      LI_CONNECT_FOLLOW (1), LI_CONNECT_GAP_MS (20000).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { HelmStackClient, LinkedIn } = require("../tools/helmstack-social/src");
const { logLinkedIn } = require("./posts_log");
const { passOutbound } = require("./lib/outbound_gates");
const QUERIES = require("./lib/linkedin_connect_queries");

const ROOT = path.resolve(__dirname, "..");
const VOCATION = path.join(ROOT, "vocation.md");
const LEDGER = path.join(ROOT, "state", "linkedin_connected.json");

const CYCLE = Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null;
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";
const MAX_DAY = Number.parseInt(process.env.LI_CONNECT_MAX_DAY || "10", 10);
const PER_RUN = Number.parseInt(process.env.LI_CONNECT_PER_RUN || "5", 10);
const RELEVANCE_MIN = Number.parseInt(process.env.LI_CONNECT_RELEVANCE_MIN || "2", 10);
const NOTE_ENABLED = process.env.LI_CONNECT_NOTE !== "0";
const FOLLOW_FALLBACK = process.env.LI_CONNECT_FOLLOW !== "0";
const GAP_MS = Number.parseInt(process.env.LI_CONNECT_GAP_MS || "20000", 10);
const MAX_NOTE = 200; // LinkedIn free-tier invite-note character cap

const tag = "linkedin_connect";
const log = (m) => console.log(`[${tag}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// ── Ledger (invited profiles + query rotation pointer) ──────────────────────────
function loadLedger() {
  try { const l = JSON.parse(fs.readFileSync(LEDGER, "utf-8")); return { invited: l.invited || [], qptr: l.qptr || 0 }; }
  catch { return { invited: [], qptr: 0 }; }
}
function saveLedger(l) {
  try { fs.writeFileSync(LEDGER, JSON.stringify({ invited: l.invited.slice(-1000), qptr: l.qptr }, null, 2)); } catch {}
}

// ── On-mission relevance of a search hit (0-3, local brain; fails OPEN) ─────────
async function scoreTarget(person) {
  const blurb = `${person.name}${person.headline ? " — " + person.headline : ""}`.trim();
  if (!blurb) return 0;
  try {
    const { generate: llmGenerate } = require("./llm");
    const raw = await llmGenerate(
      `Sebastian Hunter analyzes how narratives are constructed in public discourse: political messaging, ` +
      `media framing, propaganda, disinformation, institutional accountability, information integrity (esp. the Philippines).\n\n` +
      `Rate how relevant this LinkedIn person is as a professional connection for that mission. Recruiters, sales, ` +
      `generic marketers, crypto/MLM, and unrelated corporate roles = 0. Journalists, fact-checkers, researchers, ` +
      `academics, policy/governance, and media/AI-integrity people = 2-3.\n\n` +
      `Answer with a SINGLE digit 0-3.\n\nPERSON: "${blurb.slice(0, 200)}"\n\nDigit:`,
      { temperature: 0, maxTokens: 5, timeoutMs: 30_000 }
    );
    const m = String(raw).match(/[0-3]/);
    return m ? Number(m[0]) : 2;
  } catch { return 2; }
}

// ── Personalized connection note (Claude, voice-gated) ──────────────────────────
async function buildNote(person) {
  const { compose } = require("./lib/compose");
  let persona = "";
  try {
    const { buildPersona } = require("./lib/sebastian_respond");
    persona = buildPersona("reply");
  } catch {
    try { persona = "You are Sebastian Hunter. " + fs.readFileSync(VOCATION, "utf-8").slice(0, 800); }
    catch { persona = "You are Sebastian Hunter, mapping how narratives are constructed in public discourse."; }
  }
  const prompt = persona +
    `\n\nYou are writing a LinkedIn CONNECTION-REQUEST note to ${person.name}` +
    `${person.headline ? `, whose headline reads: "${person.headline}"` : ""}.\n` +
    `Write a short, specific, professional note (STRICTLY under ${MAX_NOTE} characters) on why you'd value connecting — ` +
    `reference their actual work/field and tie it to your own focus on narratives, media, or accountability. ` +
    `First person, warm but credible. No emojis, no hashtags, no links, no "I came across your profile" filler, ` +
    `no throat-clearing. If you cannot write something genuine and specific, return SKIP.\n\nReturn ONLY the note text.`;
  try {
    const raw = await compose(prompt, { maxTokens: 200, model: "gemini-2.5-flash", thinkingBudget: 0, tag });
    const gated = await passOutbound(raw, { gates: ["voice"], maxLen: MAX_NOTE, tag });
    if (!gated.ok) { log(`note gate rejected (${gated.reason}) — will send without a note`); return ""; }
    return gated.text.slice(0, MAX_NOTE);
  } catch (err) { log(`note generation failed (${err.message}) — will send without a note`); return ""; }
}

// ── Main ────────────────────────────────────────────────────────────────────────
(async () => {
  const li = new LinkedIn(new HelmStackClient(), { ownHandleHint: "sebastian hunter", log });
  try {
    await li.ensureTab();
    if (!(await li.sessionOk())) { log("LinkedIn session not present (no li_at) — is HelmStack logged in?"); process.exit(0); }
  } catch (err) { log(`could not reach HelmStack/LinkedIn: ${err.message}`); process.exit(0); }

  const ledger = loadLedger();
  const invitedUrls = new Set(ledger.invited.map((x) => x.url));
  const sentToday = ledger.invited.filter((x) => x.date === today()).length;
  const remaining = Math.max(0, MAX_DAY - sentToday);
  if (remaining === 0) { log(`daily cap reached (${sentToday}/${MAX_DAY}) — nothing to do`); process.exit(0); }

  const query = QUERIES[ledger.qptr % QUERIES.length];
  ledger.qptr = (ledger.qptr + 1) % QUERIES.length; // advance rotation regardless of outcome
  saveLedger(ledger);
  log(`query "${query}" — ${sentToday}/${MAX_DAY} done today, ${remaining} left; note=${NOTE_ENABLED ? "on" : "off"}, follow-fallback=${FOLLOW_FALLBACK ? "on" : "off"}${DRY_RUN ? " [dry-run]" : ""}`);

  const results = await li.searchPeople(query, { limit: 14 });
  log(`${results.length} result(s) found`);

  const target = Math.min(remaining, PER_RUN);
  let done = 0, invites = 0, follows = 0;
  let noteMode = NOTE_ENABLED;
  for (const person of results) {
    if (done >= target) break;
    if (invitedUrls.has(person.profileUrl)) continue;

    const score = await scoreTarget(person);
    if (score < RELEVANCE_MIN) { log(`skip @${person.name} (relevance ${score})`); continue; }

    const note = noteMode ? await buildNote(person) : "";
    const res = await li.connect(person.profileUrl, { note, allowFollow: FOLLOW_FALLBACK, dryRun: DRY_RUN });

    if (res.dryRun) { log(`[dry] would ${res.action || "act"} @${person.name} (score ${score})${res.action === "connect" && note ? " +note" : ""}`); done++; continue; }
    if (res.ok) {
      done++;
      if (res.action === "follow") follows++; else invites++;
      invitedUrls.add(person.profileUrl);
      ledger.invited.push({ url: person.profileUrl, name: person.name, action: res.action, note: res.noteSent ? note : "", date: today() });
      saveLedger(ledger);
      logLinkedIn({ type: `linkedin_${res.action}`, content: res.noteSent ? note : "", target_author: person.name, target_url: person.profileUrl, cycle: CYCLE });
      log(`${res.action === "follow" ? "followed" : "invited"} @${person.name} (score ${score})${res.action === "connect" ? (res.noteSent ? " +note" : " (no note)") : ""}${res.downgradedFrom ? ` [connect→follow: ${res.downgradedFrom}]` : ""}`);
      if (noteMode && note && res.action === "connect" && !res.noteSent) { noteMode = false; log("note editor unavailable — switching to blank invites for the rest of this run"); }
    } else if (res.reason === "already_pending") {
      invitedUrls.add(person.profileUrl); // record so we don't revisit
      ledger.invited.push({ url: person.profileUrl, name: person.name, action: "pending", note: "", date: today() });
      saveLedger(ledger);
      log(`skip @${person.name} — already pending/connected`);
    } else {
      log(`no action @${person.name} (${res.reason})`);
    }
    if (done < target) await sleep(GAP_MS); // human-ish pacing between actions
  }

  log(`done — ${invites} invite(s), ${follows} follow(s)${DRY_RUN ? " (dry run)" : ""}`);
  process.exit(0);
})().catch((err) => { log(`fatal: ${err.message}`); process.exit(0); });
