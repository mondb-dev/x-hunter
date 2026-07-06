'use strict';
/**
 * runner/lib/fb_sources.js — curated public Facebook Pages Sebastian observes.
 *
 * Chosen for his mission (mapping narrative construction/manipulation in PH
 * public discourse): mainstream news (the dominant frames), fact-checkers (who
 * actively deconstruct disinfo — closest to his own work), and investigative
 * outlets (who expose the machinery). FB is where PH narrative warfare actually
 * happens, so these are high-signal observation targets.
 *
 * Slugs that 404 simply yield no posts (the collector skips them) — safe.
 * Shared by fb_collect.js (scrape → beliefs) and fb_seed_follows.js (follow).
 */

module.exports = [
  // ── Fact-checkers / info-integrity (most on-mission) ──
  { name: "Rappler", url: "https://www.facebook.com/rappler" },
  { name: "VERA Files", url: "https://www.facebook.com/verafiles" },
  { name: "PCIJ", url: "https://www.facebook.com/pcij.org" },
  { name: "Tsek.ph", url: "https://www.facebook.com/tsek.ph" },
  // ── Mainstream news (the dominant frames) ──
  { name: "ABS-CBN News", url: "https://www.facebook.com/abscbnNEWS" },
  { name: "GMA News", url: "https://www.facebook.com/gmanews" },
  { name: "Inquirer", url: "https://www.facebook.com/inquirerdotnet" },
  { name: "Manila Bulletin", url: "https://www.facebook.com/manilabulletin" },
  { name: "Philippine Star", url: "https://www.facebook.com/philstarnews" },
];
