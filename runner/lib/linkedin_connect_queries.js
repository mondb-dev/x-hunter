'use strict';
/**
 * runner/lib/linkedin_connect_queries.js — niche People-search queries Sebastian
 * rotates through when growing his LinkedIn network.
 *
 * Chosen for his mission (mapping how narratives are constructed/manipulated in
 * PH public discourse): the people whose work overlaps his — journalists,
 * fact-checkers, disinfo/OSINT researchers, media-literacy and governance folks,
 * and the AI-narrative crowd. Connecting with these raises the odds of a warm
 * accept and a genuinely relevant feed.
 *
 * linkedin_connect.js rotates through these one query per run (pointer in the
 * ledger), searches People, and sends note-personalized invites (capped/day).
 */

module.exports = [
  "Philippines disinformation researcher",
  "Philippine investigative journalist",
  "fact-checker Philippines",
  "media literacy Philippines",
  "Philippines political communication",
  "information integrity researcher",
  "OSINT disinformation analyst",
  "propaganda researcher",
  "Philippine governance accountability",
  "digital rights Philippines",
  "AI policy narrative researcher",
  "computational propaganda",
];
