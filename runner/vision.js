#!/usr/bin/env node
/**
 * runner/vision.js — image description via CLAUDE (multimodal)
 *
 * Exports:
 *   describeImage(base64, mimeType, context)  → Promise<string>   image description
 *   describeMedia(mediaItems)                 → Promise<Map>       batch describe
 *
 * INFERENCE POLICY: Claude, never Gemini. The Vertex/Gemini multimodal transport
 * is removed.
 *
 * HOW: the image is handed to `claude -p` as a base64 image CONTENT BLOCK over
 * --input-format stream-json. That matters — the obvious route (ask Claude to
 * Read an image path) needs the Read TOOL, and tool use inside a nested
 * claude-spawns-claude session fails with `tool_use ids must be unique`. Passing
 * the image as content uses no tools at all, so it is immune to that.
 *
 * Callers already hold the image bytes (the scraper downloads media), so nothing
 * needs to browse or screenshot to obtain them — that would only add latency and
 * re-encode loss. Screenshot-then-describe is the right shape for the DIFFERENT
 * job of describing a rendered page, not for media we already have.
 */

"use strict";

const { spawn } = require("child_process");

// Each description is its own `claude -p` process. Parallel spawns are where
// flakiness shows up (measured in a nested claude-in-claude session: 3/3 success
// sequentially vs 2/3 at concurrency 3, the failure being a transient
// `tool_use ids must be unique` 400). Media description is batch work with no
// latency pressure, so default modestly and let the operator tune.
const MAX_CONCURRENT = Number.parseInt(process.env.VISION_CONCURRENCY || "2", 10);
const TIMEOUT_MS     = Number.parseInt(process.env.VISION_TIMEOUT_MS || "45000", 10);

/** Valid Anthropic image media types; anything else is rejected up front. */
const OK_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Identify the image type from its MAGIC BYTES rather than trusting the caller.
 * Scraped media routinely carries a wrong or vague Content-Type, and the API
 * rejects a declared/actual mismatch outright ("The image was specified using
 * the image/jpeg media type but..."). Sniffing makes a mislabelled scrape work
 * instead of silently losing the description. Returns null if unrecognised.
 */
function sniffMime(base64) {
  let head;
  try { head = Buffer.from(String(base64).slice(0, 32), "base64"); } catch { return null; }
  if (head.length < 4) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
  if (head.slice(0, 4).toString("ascii") === "RIFF" && head.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/**
 * Describe a single image with Claude.
 *
 * @param {string} base64 - base64-encoded image data (no data: prefix)
 * @param {string} mimeType - e.g. "image/png", "image/jpeg"
 * @param {string} [context=""] - optional post text for context
 * @returns {Promise<string|null>} description or null on error (never throws)
 */
async function describeImage(base64, mimeType, context = "", { attempts = 2 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const out = await describeImageOnce(base64, mimeType, context);
    if (out) return out;
    if (i < attempts) await new Promise((r) => setTimeout(r, 1200));   // transient 400/timeout
  }
  return null;
}

function describeImageOnce(base64, mimeType, context = "") {
  if (!base64) return Promise.resolve(null);
  // Trust the BYTES over the declared type (scrapes mislabel constantly); fall
  // back to the caller's value, normalising the common jpg → jpeg slip.
  const declared = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  const mime = sniffMime(base64) || declared;
  if (!OK_MIME.has(mime)) {
    console.warn(`[vision] unsupported image type ${mime || mimeType || "unknown"} — skipping`);
    return Promise.resolve(null);
  }

  const contextNote = context
    ? `This image is attached to a post that says: "${String(context).slice(0, 300)}"\n\n`
    : "";
  const prompt = `${contextNote}Describe this image concisely in 1-2 sentences. Focus on: what is shown, any text visible in the image, and the key message or claim being made. If it's a chart or infographic, summarize the data. If it's a meme, describe the format and message. If it's a screenshot of text, transcribe the key content. Reply with the description only.`;

  const payload = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
        { type: "text", text: prompt },
      ],
    },
  });

  return new Promise((resolve) => {
    const bin = process.env.CLAUDE_BIN || "claude";
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",   // stream-json input REQUIRES stream-json output…
      "--verbose",                         // …which in turn REQUIRES --verbose. Both are load-bearing.
      "--allowedTools", "",                // no tools: the image rides in as content
      // Hard-isolate the subprocess. --allowedTools alone still let an inherited
      // MCP/tool config through, and any tool turn trips a `tool_use ids must be
      // unique` 400. Vision needs no tools at all, so give it none.
      "--strict-mcp-config",
      "--mcp-config", "{\"mcpServers\":{}}",
    ];
    if (process.env.CLAUDE_VISION_MODEL) args.push("--model", process.env.CLAUDE_VISION_MODEL);

    let child;
    try { child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { console.warn(`[vision] spawn failed: ${e.message}`); return resolve(null); }

    let out = "", err = "", settled = false;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(v); };
    const timer = setTimeout(() => { console.warn("[vision] timeout"); finish(null); }, TIMEOUT_MS);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { console.warn(`[vision] spawn error: ${e.message}`); finish(null); });
    child.on("close", () => {
      // stream-json emits one JSON object per line; the final `result` carries the text.
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let j; try { j = JSON.parse(t); } catch { continue; }
        if (j.type === "result") {
          if (j.is_error) { console.warn(`[vision] claude error: ${String(j.result).slice(0, 160)}`); return finish(null); }
          const text = String(j.result || "").trim();
          return finish(text || null);
        }
      }
      console.warn(`[vision] no result in output${err ? ` (stderr: ${err.slice(0, 160)})` : ""}`);
      finish(null);
    });

    child.stdin.write(payload + "\n");
    child.stdin.end();
  });
}

/**
 * Batch-describe media items with concurrency control.
 *
 * @param {Array<{postId: string, base64: string, mimeType: string, context: string, mediaType: string}>} items
 * @returns {Promise<Map<string, string>>} postId → description
 */
async function describeMedia(items) {
  const results = new Map();
  if (!items || items.length === 0) return results;

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
    const batch = items.slice(i, i + MAX_CONCURRENT);
    const promises = batch.map(async (item) => {
      const desc = await describeImage(item.base64, item.mimeType, item.context);
      if (desc) {
        const prefix = item.mediaType === "video" ? "[VIDEO] " : "[IMAGE] ";
        results.set(item.postId, prefix + desc);
      }
    });
    await Promise.all(promises);
  }

  return results;
}

module.exports = { describeImage, describeMedia };
