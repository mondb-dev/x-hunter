/**
 * runner/landmark/render.js — Card renderer
 *
 * Composites the hero art into the SVG card frame and produces
 * the final card image. Two output modes:
 *
 *   1. SVG-only (default): embeds the hero art as a base64 data URI
 *      inside the SVG. Lightweight, no extra deps.
 *
 *   2. PNG (optional): if puppeteer-core is available, renders the
 *      SVG to a raster PNG using a headless browser. Required for
 *      NFT metadata since most wallets don't render SVG.
 *
 * The render pipeline:
 *   event data + hero art buffer → generateCard() → SVG string
 *                                                 → optional PNG render
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { generateCard } = require("./card");
const { PATHS } = require("./config");

// ── SVG with embedded art ─────────────────────────────────────────────────────

/**
 * Render a complete card SVG with hero art embedded.
 *
 * @param {object} event       - landmark event from detect.js
 * @param {object} content     - editorial content from editorial.js
 * @param {Buffer|null} artBuf - hero art PNG buffer (or null for placeholder)
 * @param {object} opts
 * @param {number} opts.editionNumber  - this edition's number
 * @param {number} opts.editionSupply  - total supply
 * @param {number} opts.landmarkNumber - sequential landmark ID
 * @returns {string} SVG string
 */
function renderCardSvg(event, content, artBuf, opts = {}) {
  const heroArtDataUri = artBuf
    ? `data:image/png;base64,${artBuf.toString("base64")}`
    : null;

  const dateStr = event.windowStart
    ? new Date(event.windowStart).toISOString().slice(0, 16).replace("T", " ")
    : new Date().toISOString().slice(0, 10);

  return generateCard({
    headline:       content.headline || "Landmark Event",
    dateStr,
    signalCount:    event.signalCount,
    signals:        event.signals,
    stats:          event.stats || {},
    editionNumber:  opts.editionNumber || 1,
    editionSupply:  opts.editionSupply,
    landmarkNumber: opts.landmarkNumber || 1,
    heroArtDataUri,
  });
}

// ── PNG rendering via Puppeteer ───────────────────────────────────────────────

/**
 * Render SVG string to a PNG Buffer using puppeteer-core.
 *
 * @param {string} svg - SVG string to render
 * @returns {Promise<Buffer>} PNG buffer
 */
async function svgToPng(svg) {
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch {
    throw new Error("[render] puppeteer-core not available — cannot render PNG");
  }

  // Find Chrome/Chromium
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error("[render] No Chrome/Chromium binary found");
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 840, deviceScaleFactor: 2 });

    // Render SVG as a page
    const html = `
      <!DOCTYPE html>
      <html><head><style>
        * { margin: 0; padding: 0; }
        body { width: 600px; height: 840px; overflow: hidden; }
      </style></head>
      <body>${svg}</body></html>
    `;

    await page.setContent(html, { waitUntil: "networkidle0" });
    const buf = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 600, height: 840 },
    });

    return Buffer.from(buf);
  } finally {
    await browser.close();
  }
}

/** Try to find Chrome binary on common paths */
function findChrome() {
  const candidates = [
    // Linux
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Snap
    "/snap/bin/chromium",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Check PATH via which
  try {
    const { execSync } = require("child_process");
    const result = execSync("which chromium-browser || which chromium || which google-chrome", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (result) return result.split("\n")[0];
  } catch { /* ignore */ }

  return null;
}

// ── Full render pipeline ──────────────────────────────────────────────────────

/**
 * Render the card and save to disk. Returns paths to saved files.
 *
 * @param {object} event
 * @param {object} content
 * @param {Buffer|null} artBuf
 * @param {object} opts
 * @param {number} opts.landmarkNumber
 * @param {string} [opts.outputDir] - override output directory
 * @param {boolean} [opts.png=true] - also render PNG
 * @returns {Promise<{svgPath: string, pngPath: string|null}>}
 */
async function renderAndSave(event, content, artBuf, opts = {}) {
  const lnum = opts.landmarkNumber || 1;
  const dir  = opts.outputDir || path.join(PATHS.LANDMARKS_DIR, `landmark_${lnum}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const svg = renderCardSvg(event, content, artBuf, {
    editionNumber:  1,                 // master edition = #1
    editionSupply:  opts.editionSupply,
    landmarkNumber: lnum,
  });

  const svgPath = path.join(dir, `landmark_${lnum}_card.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`[render] SVG card saved: ${svgPath}`);

  let pngPath = null;
  if (opts.png !== false) {
    try {
      const pngBuf = await svgToPng(svg);
      pngPath = path.join(dir, `landmark_${lnum}_card.png`);
      fs.writeFileSync(pngPath, pngBuf);
      console.log(`[render] PNG card saved: ${pngPath}`);
    } catch (err) {
      console.warn(`[render] PNG render failed: ${err.message} — SVG only`);
    }
  }

  return { svgPath, pngPath };
}

module.exports = { renderCardSvg, svgToPng, renderAndSave };
