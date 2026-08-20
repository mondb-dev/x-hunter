#!/usr/bin/env node
/**
 * runner/stance_video.js — daily video: Sebastian states his stance, on camera.
 *
 * A recurring series: one short clip per day of the canonical chick character
 * (runner/image_style.js CHARACTER_DIRECTIVE) delivering his current position
 * out loud, standing somewhere concrete tied to that position. Subject
 * priority:
 *   1. the newest OPEN stance (lib/stances — committed, research-backed)
 *   2. else the strongest-conviction belief axis (confidence + |score|)
 *   3. else the axis that moved most today
 *
 * The spoken line is composed by the think backend (Claude), calibrated to the
 * stance's confidence (no overclaiming), and passed through the shared
 * outbound gates (voice + fact-check) — same bar as anything else he says in
 * public. The clip is generated through the Gemini web engine (Veo speaks the
 * line; Veo 3 renders dialogue + ambient audio).
 *
 * VOICE CONSISTENCY (operator decision 2026-08-05): Veo has no voice-lock —
 * no API, no seed, no reference audio, just a text prompt — so the brief LLM
 * used to re-author the voice description from scratch each day, which was
 * itself a source of drift. The voice is now `image_style.js VOICE_DIRECTIVE`,
 * a fixed string spliced into every video_prompt verbatim (buildVideoPrompt
 * below); the brief LLM only picks topic/location/language/spoken_line, never
 * the voice text. Language follows the same TAGALOG RULE as tweets/threads
 * (see lib/prompts/tweet.js): PH-rooted topics speak in Taglish, everything
 * else in English — same accent (VOICE_DIRECTIVE) either way.
 *
 * Honest gating: video generation needs a Veo entitlement on the Google
 * account signed into the HelmStack browser. Until then this logs the reason
 * and exits 0 — the series starts itself the first day generation works.
 *
 * Output:  state/videos/stance_YYYY-MM-DD.mp4 (gitignored)
 * Review:  sent to the admin Telegram chat.
 * PUBLISH: posts to X and cross-posts to Facebook BY DEFAULT (disable with
 *          STANCE_VIDEO_POST=0 / STANCE_VIDEO_FB=0). The old "nothing is posted
 *          publicly yet" note was stale — this goes live when generation works.
 *
 * Invoked daily from the orchestrator maintenance block, detached.
 * Gate: STANCE_VIDEO_ENABLED != 0.
 *
 * Usage: node runner/stance_video.js [--dry-run]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state");
const VIDEOS_DIR = path.join(STATE, "videos");
const STAMP = path.join(STATE, "stance_video_state.json");
const DRY = process.argv.includes("--dry-run");

const watchdog = setTimeout(() => {
  console.error("[stance_video] watchdog: 20 min elapsed — exiting");
  process.exit(0);
}, 20 * 60 * 1000);
watchdog.unref();

const today = () => new Date().toISOString().slice(0, 10);
function log(m) { console.log(`[stance_video] ${m}`); }
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fb; } }

// ── 1. Pick today's subject ───────────────────────────────────────────────────

function pickSubject() {
  // 1. Newest open stance he hasn't ruled out for video.
  //    Whether a stance earns a piece to camera is HIS call, made in
  //    stance_scan's reflect pass. A stance he explicitly declined (or already
  //    filmed) is skipped here and the series falls through to the axis
  //    fallbacks below — so his "no" is respected without ending the daily run.
  try {
    const { activeStances, declinedMedia, producedMedia } = require("./lib/stances");
    const open = activeStances()
      .filter((s) => !declinedMedia(s, "video") && !producedMedia(s, "video"))
      .sort((a, b) => String(b.taken_at || "").localeCompare(String(a.taken_at || "")));
    if (open.length) {
      const s = open[0];
      return {
        kind: "stance",
        stanceId: s.id,
        text: `EVENT: ${s.event}\nQUESTION: ${s.question || ""}\nHIS SIDE: ${s.side} (position ${s.position}, spectrum ${s.pole_a} ↔ ${s.pole_b})\nCONFIDENCE it resolves his way: ${s.confidence_pct}%\nRATIONALE: ${s.rationale || ""}`,
      };
    }
  } catch (e) { log(`stances unavailable (${e.message})`); }

  // 2. Strongest-conviction axis
  const onto = readJson(path.join(STATE, "ontology.json"), { axes: [] });
  const strong = (onto.axes || [])
    .filter((a) => (a.confidence || 0) >= 0.65)
    .sort((x, y) => Math.abs(y.score || 0) - Math.abs(x.score || 0))[0];
  if (strong && Math.abs(strong.score || 0) >= 0.15) {
    // State the position IN WORDS, not as a signed score.
    //
    // This shipped inverted to production once already: on 2026-07-25 the video
    // said "I believe in open borders" while the immigration axis sat at +0.876
    // toward "national sovereignty, strict border control" — the exact opposite
    // of the committed position, spoken on camera and cross-posted to X and
    // Facebook. Claude composed that one, so this is NOT a weak-model problem:
    // `SCORE: 0.87 (−1..+1)` next to a "PoleA vs. PoleB" label is ambiguous
    // enough to flip a frontier model. Naming the side, and quoting his own
    // current_stance, produced a correct line on the first attempt in testing.
    // `current_stance` is the load-bearing field: it is his position in his own
    // first-person words, so it cannot be mis-read the way a signed score can.
    // The poles are given as ORIENTATION, never as "he rejects X" — on many axes
    // they are descriptive observations rather than advocacy positions ("...
    // prioritizes formal processes over substantive outcomes" is a diagnosis of
    // how institutions behave, not a thing to be for or against), so instructing
    // the model to argue against the far pole would manufacture a new inversion.
    const side = (strong.score || 0) >= 0 ? strong.right_pole : strong.left_pole;
    return {
      kind: "conviction",
      axis: {
        poleA: strong.left_pole || "one side",
        poleB: strong.right_pole || "the other side",
        score: strong.score || 0,
      },
      text:
        `BELIEF AXIS: ${strong.label || strong.id}\n` +
        (strong.current_stance
          ? `HIS POSITION, IN HIS OWN WORDS: ${String(strong.current_stance).slice(0, 400)}\n`
          : "") +
        `HE LEANS TOWARD: ${side}\n` +
        `CONFIDENCE: ${strong.confidence}\n` +
        `Evidence entries: ${(strong.evidence_log || []).length}\n` +
        `Speak from the position above, in his voice. Do not argue the opposite of it.`,
    };
  }

  // 3. Axis that moved most vs the archived ontology
  const prevPath = [1, 2, 3]
    .map((i) => path.join(STATE, "archive", `ontology_${new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)}.json`))
    .find((p) => fs.existsSync(p));
  const prev = prevPath ? readJson(prevPath, { axes: [] }) : { axes: [] };
  const prevById = new Map((prev.axes || []).map((a) => [a.id || a.label, a]));
  const mover = (onto.axes || [])
    .map((a) => ({ a, d: Math.abs((a.score || 0) - ((prevById.get(a.id || a.label) || {}).score || 0)) }))
    .sort((x, y) => y.d - x.d)[0];
  if (mover && mover.d > 0) {
    return { kind: "movement", text: `AXIS THAT MOVED MOST TODAY: ${mover.a.label || mover.a.id} (moved ${mover.d.toFixed(3)}, score now ${mover.a.score})` };
  }
  return null;
}

// ── 2. Script brief via the think backend ────────────────────────────────────

// Builds the actual Veo prompt in CODE, not the LLM — VOICE_DIRECTIVE must be
// byte-identical every generation (see the VOICE CONSISTENCY note up top).
// Re-callable after gating corrects spoken_line, so there's no fragile
// string-replace against LLM-authored prose.
function buildVideoPrompt({ location, spoken_line }) {
  const { CHARACTER_DIRECTIVE, VOICE_DIRECTIVE } = require("./image_style");
  return (
    `Stylized animation, wide cinematic 16:9. ${CHARACTER_DIRECTIVE} ` +
    `He is standing in: ${location}. He looks into the camera and says, in ` +
    `${VOICE_DIRECTIVE}: "${spoken_line}" — include the quoted line verbatim. ` +
    `One slow camera push-in, ambient location sound, moody palette matching ` +
    `the subject, no on-screen text, no human faces.`
  );
}

async function composeBrief(subject) {
  const { reason } = require("./lib/compose");
  const { CHARACTER_DIRECTIVE } = require("./image_style");
  const prompt = [
    `Today is ${today()}. Sebastian D. Hunter is an AI discourse analyst who commits to positions`,
    `and says them out loud. Write today's 8-second to-camera stance clip.`,
    ``,
    `TODAY'S SUBJECT (${subject.kind}):`,
    subject.text,
    ``,
    `CHARACTER SHEET (a reference image is attached at generation): ${CHARACTER_DIRECTIVE}`,
    ``,
    `RULES for the spoken line: first person, max 25 words, one or two sentences, concrete and`,
    `declarative — state the position AND one reason. NAME NAMES: say the specific people,`,
    `institutions, and events the evidence names — never "some senators" or "certain officials"`,
    `when the record says who. Directness is the voice; do not hedge for politeness. Calibrate`,
    `certainty ONLY to the stated confidence: below 50% say "I think"/"leaning"; 50-75% say it`,
    `plainly; above 75% say it firmly. No hashtags, no jargon, no "as an AI".`,
    ``,
    `TAGALOG RULE (same rule his tweets/threads follow — see lib/prompts/tweet.js): if the`,
    `subject is primarily about the Philippines, Filipino politics, PH governance, OFW issues,`,
    `or Filipino culture — write the spoken_line in natural spoken Taglish (Tagalog-English`,
    `code-switch, the way Filipinos actually talk), NEVER formal/textbook Tagalog. Otherwise`,
    `— international/geopolitical/non-PH subjects — write in English. Either way the voice`,
    `(accent, pacing) is fixed elsewhere; you are only choosing the WORDS.`,
    ``,
    `Output ONLY raw JSON — do NOT include a voice or camera description, that is added in code:`,
    `{"topic": "<3-6 words>", "location": "<concrete place tied to the subject, 3-8 words>",`,
    `"language": "<'taglish' or 'english', per the TAGALOG RULE above>",`,
    `"spoken_line": "<the line he says, in that language, max 25 words>"}`,
  ].join("\n");

  const raw = await reason(prompt, { maxTokens: 900, tag: "stance_video" });
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`brief not JSON: ${String(raw).slice(0, 120)}`);
  const brief = JSON.parse(m[0]);
  if (!brief.spoken_line || !brief.location) throw new Error("brief missing spoken_line/location");
  brief.video_prompt = buildVideoPrompt(brief);
  return brief;
}

// The spoken line is public-facing speech — same bar as any other outbound.
/**
 * Does the line argue the side he actually committed to?
 *
 * Runs on EVERY backend, not just the local one. The 2026-07-25 inversion ("I
 * believe in open borders" on an axis committed to strict border control) was
 * composed by Claude and passed voice + factcheck untouched — those gates check
 * tics and officeholder facts, neither of which can see a reversed position.
 * Uses the local model for the check because it is a single-letter
 * classification, the one thing a small model does reliably.
 *
 * Fails OPEN when it cannot verify: an unavailable checker must not silence the
 * daily series. It only blocks on a POSITIVE finding of inversion.
 */
async function verifyStance(line, axis) {
  if (!axis || typeof axis.score !== "number") return null; // stance-tier subjects carry no axis
  try {
    const local = require("./lib/local_llm");
    if (!local.isEnabled()) return null;
    const av = await local.isAvailable();
    if (!av.ok) { log(`stance check skipped — local model unavailable (${av.reason})`); return null; }
    const { checkStance } = require("./lib/local_harness");
    return await checkStance(line, axis);
  } catch (e) {
    log(`stance check unavailable (${e.message}) — not blocking`);
    return null;
  }
}

async function gateSpokenLine(line, axis) {
  // Position check FIRST: a reversed stance is not fixable by a fact-correction,
  // so there is no point spending the factcheck call on it.
  const inverted = await verifyStance(line, axis);
  if (inverted) {
    log(`spoken line REJECTED — ${inverted}`);
    return null;
  }
  try {
    const { passOutbound } = require("./lib/outbound_gates");
    const r = await passOutbound(line, { gates: ["voice", "factcheck"], tag: "stance_video" });
    if (r && r.ok === false) { log(`spoken line rejected by gates: ${r.reason}`); return null; }
    return (r && r.text) || line;
  } catch (e) {
    log(`gates unavailable (${e.message}) — using line as composed`);
    return line;
  }
}

// ── 3. Telegram review delivery ───────────────────────────────────────────────

function sendTelegramVideo(filePath, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { log("no telegram config — skipping review delivery"); return Promise.resolve(); }

  const boundary = "----hsstance" + Date.now();
  const field = (name, value) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${path.basename(filePath)}"\r\nContent-Type: video/mp4\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([field("chat_id", chatId), field("caption", caption.slice(0, 1000)), fileHead, fs.readFileSync(filePath), tail]);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${token}/sendVideo`,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
    }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => { log(`telegram sendVideo: HTTP ${res.statusCode}`); resolve(); });
    });
    req.on("error", (e) => { log(`telegram error (non-fatal): ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = readJson(STAMP, {});
  if (stamp.last_success === today()) { log("already produced today's video — skipping"); return; }

  const subject = pickSubject();
  if (!subject) { log("no stance, conviction, or movement to speak about — skipping"); return; }
  log(`subject (${subject.kind}): ${subject.text.split("\n")[0]}`);

  const brief = await composeBrief(subject);
  // subject.axis is present only for conviction-tier subjects; stance-tier ones
  // carry no axis and the position check no-ops for them.
  const gated = await gateSpokenLine(brief.spoken_line, subject.axis);
  if (!gated) return;
  if (gated !== brief.spoken_line) {
    brief.spoken_line = gated;
    brief.video_prompt = buildVideoPrompt(brief); // rebuild, don't string-replace LLM prose
  }
  log(`topic: ${brief.topic} | location: ${brief.location} | language: ${brief.language || "?"}`);
  log(`line: "${brief.spoken_line}"`);

  if (DRY) { log("dry-run: skipping generation"); return; }

  const { HelmStackClient, Gemini } = require("../tools/helmstack-social/src");
  const { CHARACTER_REFERENCE_IMAGE } = require("./image_style");
  const gemini = new Gemini(new HelmStackClient());
  const video = await gemini.generateVideo(brief.video_prompt, {
    timeoutMs: 10 * 60 * 1000,
    referenceImagePath: fs.existsSync(CHARACTER_REFERENCE_IMAGE) ? CHARACTER_REFERENCE_IMAGE : null,
  });
  if (!video) {
    log("no video today (see [gemini] reason above) — will retry tomorrow");
    fs.writeFileSync(STAMP, JSON.stringify({ ...stamp, last_attempt: today(), last_reason: "engine returned null" }, null, 2));
    return;
  }

  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const outPath = path.join(VIDEOS_DIR, `stance_${today()}.mp4`);
  fs.writeFileSync(outPath, video.buffer);
  log(`saved ${outPath} (${(video.buffer.length / 1048576).toFixed(1)} MB)`);
  // Latch it on the stance so the series moves on instead of refilming the same
  // position tomorrow (no-op for axis-fallback subjects, which carry no id).
  if (subject.stanceId) {
    try { require("./lib/stances").markMediaDone(subject.stanceId, "video", { file: outPath }); } catch { /* non-fatal */ }
  }

  await sendTelegramVideo(outPath, `Sebastian on: ${brief.topic}\n"${brief.spoken_line}"\n(${brief.location})`);

  // Launch it: post the clip to X autonomously (STANCE_VIDEO_POST=0 to hold at
  // Telegram-review only). Caption = the spoken line — it already passed the
  // outbound gates; posting failure is non-fatal (video is saved + reviewed,
  // and tomorrow brings a new episode).
  let postedUrl = null;
  if (process.env.STANCE_VIDEO_POST !== "0") {
    try {
      const { X } = require("../tools/helmstack-social/src");
      const x = new X(new (require("../tools/helmstack-social/src").HelmStackClient)());
      const r = await x.postVideo(brief.spoken_line, outPath, { dryRun: process.env.HELMSTACK_DRY_RUN === "1" });
      if (r.posted) {
        postedUrl = r.url || null;
        log(`launched on X: ${postedUrl || "(url uncaptured)"}`);
        try {
          require("./posts_log").logTweet({ content: brief.spoken_line, tweet_url: postedUrl, date: today(), type: "stance_video" });
        } catch (e) { log(`posts_log failed (non-fatal): ${e.message}`); }
      } else {
        log(`X launch failed (non-fatal): ${r.reason}`);
      }
    } catch (e) { log(`X launch error (non-fatal): ${e.message}`); }
  }

  // Cross-post to Facebook (best-effort; STANCE_VIDEO_FB=0 to disable).
  let fbPosted = false;
  if (process.env.STANCE_VIDEO_POST !== "0" && process.env.STANCE_VIDEO_FB !== "0") {
    try {
      const { HelmStackClient, FB } = require("../tools/helmstack-social/src");
      const fb = new FB(new HelmStackClient());
      const r = await fb.postVideo(brief.spoken_line, outPath, { dryRun: process.env.HELMSTACK_DRY_RUN === "1" });
      fbPosted = !!r.posted;
      log(fbPosted ? "cross-posted to Facebook" : `FB cross-post failed (non-fatal): ${r.reason}`);
    } catch (e) { log(`FB cross-post error (non-fatal): ${e.message}`); }
  }

  fs.writeFileSync(STAMP, JSON.stringify({ last_success: today(), topic: brief.topic, language: brief.language, line: brief.spoken_line, path: outPath, x_url: postedUrl, fb_posted: fbPosted }, null, 2));
}

module.exports = { buildVideoPrompt, pickSubject };

// Guarded so run_tests.js can require() this file (to exercise buildVideoPrompt)
// without kicking off a real run — main() only fires when invoked as a script.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(`[stance_video] non-fatal: ${e.message}`); process.exit(0); });
}
