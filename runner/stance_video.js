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
    return {
      kind: "conviction",
      text: `BELIEF AXIS: ${strong.label || strong.id}\nSCORE: ${strong.score} (−1..+1 between the poles)\nCONFIDENCE: ${strong.confidence}\nEvidence entries: ${(strong.evidence_log || []).length}`,
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
    `Output ONLY raw JSON:`,
    `{"topic": "<3-6 words>", "location": "<concrete place tied to the subject, 3-8 words>",`,
    `"spoken_line": "<the line he says>", "video_prompt": "<one Veo prompt: stylized animation,`,
    `wide cinematic 16:9, the canonical chick character per the character sheet standing in the`,
    `location, he looks into the camera and says in a light, dry, deadpan voice: '<spoken_line>'`,
    `— include the quoted line verbatim; one slow camera push-in, ambient location sound, moody`,
    `palette matching the topic, no on-screen text, no human faces>"}`,
  ].join("\n");

  const raw = await reason(prompt, { maxTokens: 900, tag: "stance_video" });
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`brief not JSON: ${String(raw).slice(0, 120)}`);
  const brief = JSON.parse(m[0]);
  if (!brief.video_prompt || !brief.spoken_line) throw new Error("brief missing spoken_line/video_prompt");
  return brief;
}

// The spoken line is public-facing speech — same bar as any other outbound.
async function gateSpokenLine(line) {
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
  const gated = await gateSpokenLine(brief.spoken_line);
  if (!gated) return;
  if (gated !== brief.spoken_line) {
    brief.video_prompt = brief.video_prompt.replace(brief.spoken_line, gated);
    brief.spoken_line = gated;
  }
  log(`topic: ${brief.topic} | location: ${brief.location}`);
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

  fs.writeFileSync(STAMP, JSON.stringify({ last_success: today(), topic: brief.topic, line: brief.spoken_line, path: outPath, x_url: postedUrl, fb_posted: fbPosted }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(`[stance_video] non-fatal: ${e.message}`); process.exit(0); });
