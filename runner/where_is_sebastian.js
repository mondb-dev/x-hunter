#!/usr/bin/env node
/**
 * runner/where_is_sebastian.js — daily "Where is Sebastian today?" video.
 *
 * A recurring series: one short stylized clip per day placing Sebastian in a
 * concrete location derived from that day's INCLINATIONS — the axes that moved,
 * open stances, and what he's been reading. The scene brief is composed by the
 * think backend (Claude via lib/compose.reason); the clip is generated through
 * the Gemini web app (helmstack-social Gemini engine → Veo).
 *
 * Honest gating: video generation requires a Veo entitlement on the Google
 * account signed into the HelmStack browser. Until that exists, this script
 * runs, logs the engine's reason, and exits 0 — the series simply starts on
 * the first day the entitlement works. Never fatal, never blocks the cycle.
 *
 * Output:  state/videos/where_YYYY-MM-DD.mp4 (gitignored)
 * Review:  sent to the admin Telegram chat (sendVideo) for QA before any
 *          public posting is wired up.
 *
 * Invoked daily from the orchestrator maintenance block, detached
 * (generation can run minutes). Gate: WHERE_VIDEO_ENABLED != 0.
 *
 * Usage: node runner/where_is_sebastian.js [--dry-run]   (dry-run: print the
 *        scene brief, skip generation)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state");
const VIDEOS_DIR = path.join(STATE, "videos");
const STAMP = path.join(STATE, "where_video_state.json");
const DRY = process.argv.includes("--dry-run");

// Hard watchdog: never outlive 20 minutes.
const watchdog = setTimeout(() => {
  console.error("[where] watchdog: 20 min elapsed — exiting");
  process.exit(0);
}, 20 * 60 * 1000);
watchdog.unref();

const today = () => new Date().toISOString().slice(0, 10);
function log(m) { console.log(`[where] ${m}`); }

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fb; } }
function readText(p, fb = "") { try { return fs.readFileSync(p, "utf-8"); } catch { return fb; } }

// ── 1. Today's inclinations ───────────────────────────────────────────────────

function topAxisMoves() {
  const now = readJson(path.join(STATE, "ontology.json"), { axes: [] });
  // daily_maintenance archives yesterday's ontology — diff against it if present
  const dates = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dates.push(path.join(STATE, "archive", `ontology_${d}.json`));
  }
  const prevPath = dates.find((p) => fs.existsSync(p));
  const prev = prevPath ? readJson(prevPath, { axes: [] }) : { axes: [] };
  const prevById = new Map((prev.axes || []).map((a) => [a.id || a.label, a]));

  return (now.axes || [])
    .map((a) => {
      const p = prevById.get(a.id || a.label);
      const delta = p ? Math.abs((a.score || 0) - (p.score || 0)) : 0;
      return { label: a.label || a.id, score: a.score || 0, confidence: a.confidence || 0, delta };
    })
    .sort((x, y) => y.delta - x.delta || y.confidence - x.confidence)
    .slice(0, 3);
}

function openStances() {
  try {
    const s = readJson(path.join(STATE, "stances.json"), null) || readJson(path.join(STATE, "stance_registry.json"), null);
    const list = s && (s.stances || s);
    if (!Array.isArray(list)) return [];
    return list.filter((x) => x && (x.status === "open" || !x.resolved)).slice(0, 3)
      .map((x) => `${x.event || x.title || x.id}: ${x.position || x.side || ""}`);
  } catch { return []; }
}

function gatherInclinations() {
  const axes = topAxisMoves();
  const notes = readText(path.join(STATE, "browse_notes.md")).slice(-3000);
  const curiosity = readText(path.join(STATE, "curiosity_directive.txt")).slice(0, 500);
  const stances = openStances();
  return { axes, stances, notesTail: notes, curiosity };
}

// ── 2. Scene brief via the think backend ─────────────────────────────────────

async function composeSceneBrief(inc) {
  const { reason } = require("./lib/compose");
  const prompt = [
    `Today is ${today()}. Sebastian D. Hunter is an AI discourse analyst. Based on what moved his`,
    `attention today, decide WHERE he is right now — one concrete, visually specific location tied`,
    `to his strongest inclination of the day — and what he is doing there.`,
    ``,
    `TODAY'S INCLINATIONS`,
    `Axes that moved most: ${inc.axes.map((a) => `${a.label} (score ${a.score}, moved ${a.delta.toFixed(3)})`).join("; ") || "none recorded"}`,
    inc.stances.length ? `Open stances: ${inc.stances.join("; ")}` : ``,
    inc.curiosity ? `Current curiosity: ${inc.curiosity}` : ``,
    `Recent observation notes (tail): ${inc.notesTail.slice(-1200)}`,
    ``,
    `CHARACTER SHEET (must be followed exactly): Sebastian is depicted as a faceless dark`,
    `silhouette of a man in a long dark coat and flat cap. Never a real person's likeness, never a`,
    `face, never text or lettering in frame, no national flags or symbols.`,
    ``,
    `Output ONLY raw JSON: {"location": "<city/place, 3-8 words>", "activity": "<what he's doing,`,
    `one sentence>", "video_prompt": "<a single Veo prompt for an 8-second clip: 16-bit pixel-art`,
    `animation style, wide cinematic 16:9, the character sheet silhouette in the location, one`,
    `slow camera move, ambient motion (rain, crowds, screens, traffic), moody palette matching the`,
    `topic, no text, no faces>"}`,
  ].filter(Boolean).join("\n");

  const raw = await reason(prompt, { maxTokens: 800, tag: "where_video" });
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`scene brief not JSON: ${String(raw).slice(0, 120)}`);
  const brief = JSON.parse(m[0]);
  if (!brief.video_prompt) throw new Error("scene brief missing video_prompt");
  return brief;
}

// ── 3. Telegram review delivery ───────────────────────────────────────────────

function sendTelegramVideo(filePath, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { log("no telegram config — skipping review delivery"); return Promise.resolve(); }

  const boundary = "----hswhere" + Date.now();
  const field = (name, value) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${path.basename(filePath)}"\r\nContent-Type: video/mp4\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([
    field("chat_id", chatId),
    field("caption", caption.slice(0, 1000)),
    fileHead,
    fs.readFileSync(filePath),
    tail,
  ]);

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

  const inc = gatherInclinations();
  const brief = await composeSceneBrief(inc);
  log(`today Sebastian is at: ${brief.location} — ${brief.activity}`);
  log(`veo prompt: ${brief.video_prompt.slice(0, 140)}...`);

  if (DRY) { log("dry-run: skipping generation"); return; }

  const { HelmStackClient, Gemini } = require("../tools/helmstack-social/src");
  const gemini = new Gemini(new HelmStackClient());
  const video = await gemini.generateVideo(brief.video_prompt, { timeoutMs: 10 * 60 * 1000 });
  if (!video) {
    log("no video today (see [gemini] reason above) — will retry tomorrow");
    fs.writeFileSync(STAMP, JSON.stringify({ ...stamp, last_attempt: today(), last_reason: "engine returned null" }, null, 2));
    return;
  }

  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const outPath = path.join(VIDEOS_DIR, `where_${today()}.mp4`);
  fs.writeFileSync(outPath, video.buffer);
  log(`saved ${outPath} (${(video.buffer.length / 1048576).toFixed(1)} MB)`);

  await sendTelegramVideo(outPath, `Where is Sebastian today? ${brief.location} — ${brief.activity}`);
  fs.writeFileSync(STAMP, JSON.stringify({ last_success: today(), location: brief.location, path: outPath }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(`[where] non-fatal: ${e.message}`); process.exit(0); });
