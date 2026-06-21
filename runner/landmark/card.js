/**
 * runner/landmark/card.js — Vintage movie poster trading card template
 *
 * Generates a branded SVG collectible card styled as a vintage movie
 * poster. The hero art (from Imagen) fills the background; the title
 * sits in a prominent position like a movie title, and trading card
 * data (signals, keywords, belief axes, tier) runs along the bottom.
 *
 * Card dimensions: 600×840 (standard trading card ratio ~5:7)
 *
 * Tier treatments:
 *   Tier 1              — strongest standard NFT gate, gold glow
 *   Tier 2              — article signal edition, silver metallic frame
 *   Special vocation    — green ceremonial glow
 *   Special prediction  — crimson validated-signal glow
 */

"use strict";

const { LANDMARK_TIERS } = require("./config");

// ── SVG helpers ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapText(text, maxChars) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text.slice(0, maxChars)];
}

// ── Main card generator ───────────────────────────────────────────────────────

/**
 * Generate the SVG trading card.
 *
 * @param {object} params
 * @param {string} params.headline       - event headline (movie title)
 * @param {string} params.dateStr        - date string
 * @param {number} params.signalCount    - signals fired (3-6)
 * @param {string} params.tierKey        - gate-derived tier key
 * @param {object} params.signals        - individual signal flags
 * @param {object} params.stats          - detection stats
 * @param {number} params.editionNumber  - this edition's number
 * @param {number} params.editionSupply  - total supply
 * @param {number} params.landmarkNumber - sequential landmark ID
 * @param {string} [params.heroArtDataUri] - base64 data URI for hero art
 * @returns {string} complete SVG string
 */
function generateCard(params) {
  const {
    headline,
    dateStr,
    signalCount,
    tierKey = "tier_2",
    signals,
    stats,
    editionNumber = 1,
    editionSupply,
    landmarkNumber = 1,
    heroArtDataUri,
  } = params;

  const tier = LANDMARK_TIERS[tierKey] || LANDMARK_TIERS.tier_2;
  const supply = editionSupply || tier.editionSupply;

  // Title lines (wider for poster feel)
  const titleLines = wrapText(headline, 28);

  // Fired signal names
  const firedSignals = Object.entries(signals || {})
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/([A-Z])/g, " $1").trim().toUpperCase());

  // Keywords
  const keywords = (stats.crossClusterTopics || [])
    .slice(0, 5)
    .map(t => typeof t === "string" ? t : (t.keyword || ""));

  // Belief axes
  const axes = (stats.axesImpacted || [])
    .slice(0, 3)
    .map(a => a.replace(/^axis_/, "").replace(/_v\d+$/, "").replace(/_/g, " "));

  // Hero art or moody dark background
  const heroArea = heroArtDataUri
    ? `<image x="0" y="0" width="600" height="840" href="${heroArtDataUri}" preserveAspectRatio="xMidYMid slice" />`
    : placeholderScene(tier);

  // Glowing tiers get an animated radial highlight.
  const goldGlow = tier.glow ? `
    <radialGradient id="goldGlow" cx="50%" cy="30%" r="60%">
      <stop offset="0%" stop-color="${tier.frame}" stop-opacity="0.15" />
      <stop offset="100%" stop-color="${tier.frame}" stop-opacity="0" />
    </radialGradient>
    <rect width="600" height="840" fill="url(#goldGlow)" />` : "";

  // Border treatment per tier
  const borderDefs = tier.glow
    ? `<linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
         <stop offset="0%"   stop-color="${tier.frame}" />
         <stop offset="40%"  stop-color="${tier.accent}" />
         <stop offset="60%"  stop-color="${tier.frame}" />
         <stop offset="100%" stop-color="${tier.bg}" />
       </linearGradient>
       <filter id="borderGlow">
         <feGaussianBlur stdDeviation="2.5" result="blur" />
         <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
       </filter>`
    : "";
  const borderStroke = tier.glow ? "url(#borderGrad)" : tier.frame;
  const borderWidth  = tier.glow ? 4 : (tier.name === "Tier 2" ? 3 : 2);
  const borderFilter = tier.glow ? ' filter="url(#borderGlow)"' : "";

  // Bottom data panel Y positions
  const panelTop = 540;
  const titleStartY = panelTop + 16;
  const titleLineH  = 32;
  const afterTitle   = titleStartY + titleLines.length * titleLineH + 10;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 600 840" width="600" height="840">
  <defs>
    <!-- Darken gradient over art for readability -->
    <linearGradient id="fadeBottom" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="#000" stop-opacity="0" />
      <stop offset="50%" stop-color="#000" stop-opacity="0.15" />
      <stop offset="75%" stop-color="#000" stop-opacity="0.7" />
      <stop offset="100%" stop-color="#000" stop-opacity="0.92" />
    </linearGradient>
    <!-- Darken top for header -->
    <linearGradient id="fadeTop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="#000" stop-opacity="0.75" />
      <stop offset="100%" stop-color="#000" stop-opacity="0" />
    </linearGradient>
    <!-- Vintage grain filter -->
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" result="noise" />
      <feColorMatrix type="saturate" values="0" in="noise" result="mono" />
      <feBlend in="SourceGraphic" in2="mono" mode="multiply" />
    </filter>
    ${borderDefs}
  </defs>

  <!-- Background -->
  <rect width="600" height="840" rx="12" fill="${tier.bg}" />

  <!-- Hero art (full bleed behind everything) -->
  <g clip-path="url(#cardClip)">
    ${heroArea}
  </g>
  <defs>
    <clipPath id="cardClip"><rect width="600" height="840" rx="12" /></clipPath>
  </defs>

  ${goldGlow}

  <!-- Vintage grain overlay -->
  <rect width="600" height="840" rx="12" fill="transparent" filter="url(#grain)" opacity="0.08" />

  <!-- Top gradient (header zone) -->
  <rect width="600" height="120" rx="12" fill="url(#fadeTop)" />

  <!-- Bottom gradient (data zone) -->
  <rect y="400" width="600" height="440" fill="url(#fadeBottom)" />

  <!-- ─── TOP HEADER ─── -->
  <text x="30" y="40" fill="${tier.frame}" font-size="11" font-family="monospace" letter-spacing="3" opacity="0.9">
    LANDMARK EVENT #${landmarkNumber}
  </text>
  <text x="570" y="40" fill="#AAAAAA" font-size="11" font-family="monospace" text-anchor="end" opacity="0.8">
    ${esc(dateStr)}
  </text>

  <!-- Tier + signal badge (top-right corner) -->
  <rect x="420" y="54" width="150" height="28" rx="4" fill="${tier.frame}" opacity="0.2" />
  <text x="495" y="73" fill="${tier.frame}" font-size="12" font-weight="bold" font-family="monospace" text-anchor="middle">
    ${esc(tier.badge)} · ${signalCount}/6
  </text>

  <!-- ─── TITLE (movie poster style) ─── -->
  ${titleLines.map((line, i) =>
    `<text x="300" y="${titleStartY + i * titleLineH}" fill="#FFFFFF" font-size="26" font-weight="bold"
       font-family="'Georgia', 'Times New Roman', serif" text-anchor="middle"
       letter-spacing="1" stroke="${tier.frame}" stroke-width="0.3" stroke-opacity="0.5">${esc(line)}</text>`
  ).join("\n  ")}

  <!-- ─── DATA PANEL ─── -->
  <!-- Divider line -->
  <line x1="60" y1="${afterTitle}" x2="540" y2="${afterTitle}" stroke="${tier.frame}" stroke-opacity="0.4" stroke-width="1" />

  <!-- Signals fired -->
  <text x="30" y="${afterTitle + 24}" fill="${tier.frame}" font-size="10" font-family="monospace" letter-spacing="2" opacity="0.7">SIGNALS</text>
  <text x="30" y="${afterTitle + 42}" fill="#DDDDDD" font-size="12" font-family="monospace">${esc(firedSignals.join(" · ") || "—")}</text>

  <!-- Keywords -->
  <text x="30" y="${afterTitle + 68}" fill="${tier.frame}" font-size="10" font-family="monospace" letter-spacing="2" opacity="0.7">KEYWORDS</text>
  <text x="30" y="${afterTitle + 86}" fill="#DDDDDD" font-size="12" font-family="monospace">${esc(keywords.join(" · ") || "—")}</text>

  <!-- Belief axes -->
  <text x="30" y="${afterTitle + 112}" fill="${tier.frame}" font-size="10" font-family="monospace" letter-spacing="2" opacity="0.7">BELIEF AXES</text>
  ${axes.length > 0 ? axes.map((a, i) =>
    `<text x="30" y="${afterTitle + 130 + i * 16}" fill="#BBBBBB" font-size="11" font-family="monospace">${esc(a)}</text>`
  ).join("\n  ") : `<text x="30" y="${afterTitle + 130}" fill="#888888" font-size="11" font-family="monospace">—</text>`}

  <!-- ─── BOTTOM BAR ─── -->
  <line x1="0" y1="790" x2="600" y2="790" stroke="${tier.frame}" stroke-opacity="0.2" />
  <text x="30" y="812" fill="#777777" font-size="11" font-family="monospace">
    #${editionNumber} of ${supply}
  </text>
  <text x="300" y="812" fill="#555555" font-size="10" font-family="monospace" text-anchor="middle">
    SEBASTIAN D. HUNTER
  </text>
  <text x="570" y="812" fill="#777777" font-size="10" font-family="monospace" text-anchor="end">
    sebastianhunter.fun
  </text>

  <!-- Card border (outermost, on top of everything) -->
  <rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${600 - borderWidth}" height="${840 - borderWidth}" rx="12"
        fill="none" stroke="${borderStroke}" stroke-width="${borderWidth}"${borderFilter} />
</svg>`;
}

// ── Placeholder scene (when no Imagen art) ────────────────────────────────────

function placeholderScene(tier) {
  // Dark atmospheric gradient with subtle vintage elements
  return `
    <defs>
      <radialGradient id="spotLight" cx="50%" cy="35%" r="50%">
        <stop offset="0%" stop-color="${tier.frame}" stop-opacity="0.12" />
        <stop offset="100%" stop-color="${tier.bg}" stop-opacity="0" />
      </radialGradient>
    </defs>
    <rect width="600" height="840" fill="${tier.bg}" />
    <rect width="600" height="840" fill="url(#spotLight)" />
    <circle cx="300" cy="300" r="120" fill="${tier.frame}" opacity="0.04" />
    <circle cx="300" cy="300" r="200" fill="${tier.frame}" opacity="0.02" />
    <line x1="100" y1="0" x2="100" y2="840" stroke="${tier.frame}" stroke-opacity="0.03" />
    <line x1="500" y1="0" x2="500" y2="840" stroke="${tier.frame}" stroke-opacity="0.03" />`;
}

module.exports = { generateCard };
