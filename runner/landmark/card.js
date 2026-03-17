/**
 * runner/landmark/card.js — SVG trading card template
 *
 * Generates a branded SVG collectible card for a landmark event.
 * Card layout:
 *   ┌─ HEADER: tier badge + date ────────┐
 *   │ [hero art area — placeholder/image] │
 *   ├─ HEADLINE ─────────────────────────┤
 *   │ STATS (6 signal bars)              │
 *   ├─ EDITION INFO ─────────────────────┤
 *   └─ BRANDING ─────────────────────────┘
 *
 * Hero art is injected externally (by art.js) — this module
 * generates the card frame and stat overlay as pure SVG.
 *
 * Card dimensions: 600×840 (standard trading card ratio ~5:7)
 */

"use strict";

const { CARD_TIERS, EDITION_SUPPLY } = require("./config");

// ── SVG building blocks ───────────────────────────────────────────────────────

function escSvg(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Generate a stat bar SVG snippet */
function statBar(label, emoji, value, maxValue, y, tier) {
  const pct = Math.min(value / maxValue, 1.0);
  const barWidth = 200;
  const filledWidth = Math.round(barWidth * pct);
  const displayValue = typeof value === "number" && value % 1 !== 0
    ? value.toFixed(1)
    : String(value);

  return `
    <text x="40" y="${y}" fill="${tier.frame}" font-size="11" font-family="monospace">${emoji} ${escSvg(label)}</text>
    <text x="130" y="${y}" fill="#FFFFFF" font-size="11" font-family="monospace" text-anchor="end">${escSvg(displayValue)}</text>
    <rect x="140" y="${y - 9}" width="${barWidth}" height="10" rx="2" fill="#2A2A3E" />
    <rect x="140" y="${y - 9}" width="${filledWidth}" height="10" rx="2" fill="${tier.frame}" opacity="0.8" />`;
}

// ── Main card generator ───────────────────────────────────────────────────────

/**
 * Generate the SVG trading card.
 *
 * @param {object} params
 * @param {string} params.headline       - event headline
 * @param {string} params.dateStr        - human-readable date
 * @param {number} params.signalCount    - signals fired (3-6)
 * @param {object} params.signals        - { volume, crossCluster, velocity, novelty, multiAxis, sentiment }
 * @param {object} params.stats          - { volumeZ, velocityRatio, noveltyCount, sentimentAvg, crossClusterTopics, axesImpacted }
 * @param {number} params.editionNumber  - this edition's number (e.g. 1)
 * @param {number} params.editionSupply  - total supply
 * @param {number} params.landmarkNumber - sequential landmark ID
 * @param {string} [params.heroArtDataUri] - base64 data URI for hero art (optional)
 * @returns {string} complete SVG string
 */
function generateCard(params) {
  const {
    headline,
    dateStr,
    signalCount,
    signals,
    stats,
    editionNumber = 1,
    editionSupply,
    landmarkNumber = 1,
    heroArtDataUri,
  } = params;

  const tierKey = Math.min(Math.max(signalCount, 3), 6);
  const tier = CARD_TIERS[tierKey];
  const supply = editionSupply || EDITION_SUPPLY[tierKey] || 1000;

  // Wrap headline to fit card width (~35 chars per line)
  const headlineLines = wrapText(headline, 35);

  // Signal stat values (normalized for bars)
  const statRows = [
    { label: "SIG", emoji: "⚡", value: signalCount, max: 6 },
    { label: "VOL", emoji: "📊", value: stats.volumeZ || 0, max: 6 },
    { label: "CLU", emoji: "🌐", value: (stats.crossClusterTopics || []).length, max: 8 },
    { label: "VEL", emoji: "🔄", value: stats.velocityRatio || 0, max: 5 },
    { label: "NOV", emoji: "💎", value: stats.noveltyCount || 0, max: 5 },
    { label: "SEN", emoji: "🔥", value: stats.sentimentAvg || 0, max: 20 },
  ];

  // Hero art area: either an injected image or a placeholder pattern
  const heroArt = heroArtDataUri
    ? `<image x="20" y="80" width="560" height="340" href="${heroArtDataUri}" preserveAspectRatio="xMidYMid slice" clip-path="url(#heroClip)" />`
    : generatePlaceholderArt(stats, tier);

  const statsStartY = 490 + (headlineLines.length - 1) * 22;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 600 840" width="600" height="840">
  <defs>
    <clipPath id="heroClip">
      <rect x="20" y="80" width="560" height="340" rx="8" />
    </clipPath>
    <!-- Card outer glow for premium tiers -->
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    ${tierKey >= 5 ? `
    <!-- Prismatic gradient for tier 5+ -->
    <linearGradient id="prismGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#E040FB" />
      <stop offset="33%" stop-color="#7C4DFF" />
      <stop offset="66%" stop-color="#00BCD4" />
      <stop offset="100%" stop-color="#FFD700" />
    </linearGradient>` : ""}
  </defs>

  <!-- Background -->
  <rect width="600" height="840" rx="16" fill="${tier.bg}" />

  <!-- Card border -->
  <rect x="8" y="8" width="584" height="824" rx="12" fill="none"
        stroke="${tierKey >= 5 ? "url(#prismGrad)" : tier.frame}" stroke-width="${tierKey >= 6 ? 3 : 2}"
        ${tierKey >= 5 ? 'filter="url(#glow)"' : ""} />

  <!-- Header bar -->
  <rect x="20" y="20" width="560" height="50" rx="8" fill="${tier.accent}" opacity="0.3" />
  <text x="40" y="52" fill="${tier.frame}" font-size="14" font-weight="bold" font-family="monospace">
    ◆ LANDMARK EVENT #${landmarkNumber}
  </text>
  <text x="560" y="52" fill="#AAAAAA" font-size="12" font-family="monospace" text-anchor="end">
    ${escSvg(dateStr)}
  </text>

  <!-- Hero art area -->
  <rect x="20" y="80" width="560" height="340" rx="8" fill="#0D0D1A" />
  ${heroArt}

  <!-- Headline area -->
  <rect x="20" y="430" width="560" height="${30 + headlineLines.length * 22}" rx="8" fill="${tier.accent}" opacity="0.15" />
  ${headlineLines.map((line, i) =>
    `<text x="40" y="${455 + i * 22}" fill="#FFFFFF" font-size="16" font-weight="bold" font-family="'Helvetica Neue', Arial, sans-serif">${escSvg(line)}</text>`
  ).join("\n  ")}

  <!-- Stats panel -->
  <rect x="20" y="${statsStartY - 20}" width="560" height="170" rx="8" fill="#0D0D1A" opacity="0.6" />
  <text x="40" y="${statsStartY}" fill="#888888" font-size="10" font-family="monospace" letter-spacing="2">DETECTION STATS</text>
  ${statRows.map((s, i) => statBar(s.label, s.emoji, s.value, s.max, statsStartY + 25 + i * 22, tier)).join("")}

  <!-- Edition info -->
  <line x1="20" y1="${statsStartY + 170}" x2="580" y2="${statsStartY + 170}" stroke="${tier.frame}" stroke-opacity="0.3" />
  <text x="40" y="${statsStartY + 195}" fill="#888888" font-size="12" font-family="monospace">
    Edition #${editionNumber} of ${supply}
  </text>
  <text x="560" y="${statsStartY + 195}" fill="#888888" font-size="11" font-family="monospace" text-anchor="end">
    ${tier.name} Tier
  </text>

  <!-- Branding -->
  <text x="300" y="815" fill="#555555" font-size="11" font-family="monospace" text-anchor="middle">
    ◆ SEBASTIAN D. HUNTER · sebastianhunter.fun
  </text>
</svg>`;
}

// ── Placeholder hero art (used when no Imagen art is available) ───────────────

function generatePlaceholderArt(stats, tier) {
  // Generate a data-driven abstract pattern from the event stats
  const circles = [];
  const keywords = (stats.crossClusterTopics || []).slice(0, 6);

  for (let i = 0; i < Math.min(keywords.length * 3, 18); i++) {
    const cx = 40 + (i * 73) % 520;
    const cy = 100 + (i * 47) % 300;
    const r = 10 + (((stats.volumeZ || 0) * 7 + i * 5) % 40);
    const opacity = 0.1 + (i % 4) * 0.08;
    circles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${tier.frame}" opacity="${opacity}" />`);
  }

  // Add keyword labels
  const labels = keywords.map((t, i) => {
    const x = 50 + (i * 100) % 500;
    const y = 150 + (i * 60) % 240;
    return `<text x="${x}" y="${y}" fill="${tier.frame}" font-size="10" font-family="monospace" opacity="0.4">${escSvg(t.keyword || t)}</text>`;
  });

  return circles.join("\n    ") + "\n    " + labels.join("\n    ");
}

// ── Text wrapping ─────────────────────────────────────────────────────────────

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

module.exports = { generateCard };
