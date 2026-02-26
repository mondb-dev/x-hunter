#!/usr/bin/env node
/**
 * runner/archive.js — memory archiver
 *
 * Scans journals/, checkpoints/, and daily/ for files not yet indexed,
 * extracts plain text + RAKE keywords, indexes into the SQLite memory table,
 * then uploads each file to Arweave via Irys (funded by Solana).
 *
 * Design:
 *   - Idempotent: INSERT OR IGNORE on file_path — safe to run repeatedly
 *   - Irys upload is best-effort: if balance too low or network fails,
 *     the file is still indexed locally (tx_id stays null until next run)
 *   - Appends successful uploads to state/arweave_log.json (committed to git)
 *
 * Usage: node runner/archive.js
 * Env:   SOLANA_PRIVATE_KEY  — base58 encoded Solana private key
 *        (loaded from .env if dotenv is available, else from process.env)
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const db      = require("../scraper/db");
const { extractKeywords } = require("../scraper/analytics");

// Load .env from project root
const ENV_PATH = path.resolve(__dirname, "../.env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT          = path.resolve(__dirname, "..");
const JOURNALS_DIR  = path.join(ROOT, "journals");
const CHECKPOINTS_DIR = path.join(ROOT, "checkpoints");
const DAILY_DIR     = path.join(ROOT, "daily");
const ARWEAVE_LOG   = path.join(ROOT, "state", "arweave_log.json");

// ── HTML text extraction ──────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract <meta name="x-hunter-*" content="..."> values from HTML. */
function extractMeta(html, name) {
  const m = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))
          || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, "i"));
  return m ? m[1] : null;
}

// ── File parsers ──────────────────────────────────────────────────────────────

function parseJournal(filePath, relPath) {
  const html = fs.readFileSync(filePath, "utf-8");
  const text = stripHtml(html);

  // Try meta tags first, fall back to filename
  const metaDate = extractMeta(html, "x-hunter-date");
  const metaHour = extractMeta(html, "x-hunter-hour");
  const metaDay  = extractMeta(html, "x-hunter-day");

  // Filename: journals/YYYY-MM-DD_HH.html
  const fname = path.basename(filePath, ".html");
  const [fDate, fHour] = fname.split("_");
  const date = metaDate || fDate || "unknown";
  const hour = metaHour != null ? parseInt(metaHour) : (fHour != null ? parseInt(fHour) : null);
  const day  = metaDay  != null ? parseInt(metaDay)  : null;

  const dayLabel  = day  != null ? `Day ${day} · ` : "";
  const hourLabel = hour != null ? `${String(hour).padStart(2, "0")}:00` : "";
  const title     = `${dayLabel}${date} ${hourLabel}`.trim();

  return { type: "journal", date, hour, title, text_content: text, file_path: relPath };
}

function parseMarkdown(filePath, relPath, type) {
  const text = fs.readFileSync(filePath, "utf-8");

  // Extract date from filename: checkpoint_N.md → date from mtime; belief_report_YYYY-MM-DD.md
  const fname = path.basename(filePath, ".md");
  let date = "unknown";
  let title = fname.replace(/_/g, " ");

  if (type === "checkpoint") {
    // checkpoint_N.md
    const m = fname.match(/checkpoint[_-](\d+)/i);
    const n = m ? m[1] : "?";
    title = `Checkpoint ${n}`;
    // Use file mtime as date
    const mtime = fs.statSync(filePath).mtime;
    date = mtime.toISOString().slice(0, 10);
  } else if (type === "belief_report") {
    // belief_report_YYYY-MM-DD.md
    const m = fname.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) { date = m[1]; title = `Belief Report ${date}`; }
  }

  return { type, date, hour: null, title, text_content: text, file_path: relPath };
}

// ── Irys uploader ─────────────────────────────────────────────────────────────

let _irys = null;
async function getIrys() {
  if (_irys) return _irys;
  const key = process.env.SOLANA_PRIVATE_KEY;
  if (!key) return null;

  try {
    const Irys = require("@irys/sdk");
    const irys = new Irys({
      url:   "https://node1.irys.xyz",
      token: "solana",
      key,
      config: { providerUrl: "https://api.mainnet-beta.solana.com" },
    });
    await irys.ready();
    _irys = irys;
    return irys;
  } catch (err) {
    console.warn(`[archive] Irys init failed: ${err.message} — uploads disabled`);
    return null;
  }
}

async function uploadToIrys(irys, filePath, meta) {
  const fileBytes = fs.readFileSync(filePath);
  const contentType = filePath.endsWith(".html") ? "text/html" : "text/markdown";

  try {
    const price   = await irys.getPrice(fileBytes.length);
    const balance = await irys.getLoadedBalance();
    if (balance.lt(price)) {
      console.warn(`[archive] Irys balance too low (need ${irys.utils.fromAtomic(price)} SOL), skipping upload for ${path.basename(filePath)}`);
      return null;
    }

    const tags = [
      { name: "Content-Type", value: contentType },
      { name: "App-Name",     value: "sebastian-hunter" },
      { name: "Type",         value: meta.type },
      { name: "Date",         value: meta.date },
    ];
    if (meta.hour != null) tags.push({ name: "Hour", value: String(meta.hour) });

    const receipt = await irys.upload(fileBytes, { tags });
    return receipt.id;
  } catch (err) {
    console.warn(`[archive] Upload failed for ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}

// ── Arweave log ───────────────────────────────────────────────────────────────

function loadArweaveLog() {
  try { return JSON.parse(fs.readFileSync(ARWEAVE_LOG, "utf-8")); }
  catch { return { uploads: [] }; }
}

function appendArweaveLog(entry) {
  const log = loadArweaveLog();
  log.uploads.push(entry);
  fs.writeFileSync(ARWEAVE_LOG, JSON.stringify(log, null, 2));
}

// ── File scanner ──────────────────────────────────────────────────────────────

function scanDir(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => pattern.test(f))
    .map(f => path.join(dir, f))
    .sort();
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log("[archive] starting memory archive run...");

  const irys = await getIrys();
  if (irys) {
    const bal = await irys.getLoadedBalance();
    console.log(`[archive] Irys connected. Balance: ${irys.utils.fromAtomic(bal)} SOL`);
  } else {
    console.log("[archive] Irys unavailable — local indexing only");
  }

  let indexed = 0, uploaded = 0;

  // Helper: attempt Irys upload for a file and update db + log on success
  async function tryUpload(irys, filePath, relPath, parsed) {
    const txId = await uploadToIrys(irys, filePath, parsed);
    if (txId) {
      db.updateMemoryTxId(relPath, txId);
      appendArweaveLog({
        tx_id:       txId,
        type:        parsed.type,
        date:        parsed.date,
        hour:        parsed.hour ?? null,
        file:        relPath,
        gateway:     `https://gateway.irys.xyz/${txId}`,
        uploaded_at: new Date().toISOString(),
      });
      uploaded++;
      console.log(`[archive] uploaded to Arweave: https://gateway.irys.xyz/${txId}`);
    }
  }

  // ── Process journals ───────────────────────────────────────────────────────
  const journalFiles = scanDir(JOURNALS_DIR, /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/);
  for (const filePath of journalFiles) {
    const relPath = path.relative(ROOT, filePath);
    const existing = db.getMemoryByPath(relPath);
    if (existing) {
      // Already indexed — retry upload if tx_id still null and Irys is funded
      if (!existing.tx_id && irys) await tryUpload(irys, filePath, relPath, existing);
      continue;
    }
    const parsed = parseJournal(filePath, relPath);
    const keywords = extractKeywords(parsed.text_content, 10).join(", ");
    db.insertMemory({ ...parsed, keywords, indexed_at: Date.now() });
    indexed++;
    console.log(`[archive] indexed journal: ${parsed.title}`);
    if (irys) await tryUpload(irys, filePath, relPath, parsed);
  }

  // ── Process checkpoints ────────────────────────────────────────────────────
  const checkpointFiles = scanDir(CHECKPOINTS_DIR, /^checkpoint[_-]\d+\.md$/i);
  for (const filePath of checkpointFiles) {
    const relPath = path.relative(ROOT, filePath);
    const existing = db.getMemoryByPath(relPath);
    if (existing) {
      if (!existing.tx_id && irys) await tryUpload(irys, filePath, relPath, existing);
      continue;
    }
    const parsed = parseMarkdown(filePath, relPath, "checkpoint");
    const keywords = extractKeywords(parsed.text_content, 10).join(", ");
    db.insertMemory({ ...parsed, keywords, indexed_at: Date.now() });
    indexed++;
    console.log(`[archive] indexed checkpoint: ${parsed.title}`);
    if (irys) await tryUpload(irys, filePath, relPath, parsed);
  }

  // ── Process belief reports ─────────────────────────────────────────────────
  const reportFiles = scanDir(DAILY_DIR, /^belief_report_\d{4}-\d{2}-\d{2}\.md$/);
  for (const filePath of reportFiles) {
    const relPath = path.relative(ROOT, filePath);
    const existing = db.getMemoryByPath(relPath);
    if (existing) {
      if (!existing.tx_id && irys) await tryUpload(irys, filePath, relPath, existing);
      continue;
    }
    const parsed = parseMarkdown(filePath, relPath, "belief_report");
    const keywords = extractKeywords(parsed.text_content, 10).join(", ");
    db.insertMemory({ ...parsed, keywords, indexed_at: Date.now() });
    indexed++;
    console.log(`[archive] indexed belief report: ${parsed.title}`);
    if (irys) await tryUpload(irys, filePath, relPath, parsed);
  }

  // ── Index tweets from posts_log.json ──────────────────────────────────────
  const postsLogPath = path.join(ROOT, "state", "posts_log.json");
  if (fs.existsSync(postsLogPath)) {
    let postsData;
    try {
      const raw = fs.readFileSync(postsLogPath, "utf-8").replace(/\\'/g, "'");
      postsData = JSON.parse(raw);
    } catch { postsData = {}; }
    let newTweets = 0;
    for (const post of (postsData.posts || [])) {
      if (!post.id || !post.content) continue;
      const filePath = `state/posts_log.json#${post.id}`;
      if (db.getMemoryByPath(filePath)) continue;
      const textWithUrl = post.tweet_url
        ? `${post.content}\n\n[URL: ${post.tweet_url}]`
        : post.content;
      db.insertMemory({
        type:         "tweet",
        date:         post.date || new Date().toISOString().slice(0, 10),
        hour:         null,
        title:        `Tweet · ${post.date} · cycle ${post.cycle || "?"}`,
        text_content: textWithUrl,
        keywords:     extractKeywords(post.content, 8).join(", "),
        file_path:    filePath,
        indexed_at:   Date.now(),
      });
      newTweets++;
      indexed++;
    }
    if (newTweets) console.log(`[archive] indexed ${newTweets} new tweet(s) from posts_log.json`);
  }

  console.log(`[archive] done. indexed=${indexed}, uploaded=${uploaded}`);
  process.exit(0);
})();
