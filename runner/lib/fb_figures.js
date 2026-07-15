'use strict';
/**
 * runner/lib/fb_figures.js — curated PUBLIC FIGURES / creators Sebastian follows
 * on Facebook (parallel to fb_sources.js, which lists news/fact-checker Pages).
 *
 * These are individual public-figure profiles/creator pages on-mission for
 * mapping PH narrative construction: investigative journalists, fact-checkers,
 * and info-integrity voices. Following a public figure = the same "Follow"
 * action fb.followPage() already drives (public profiles expose a Follow button).
 *
 * SAFETY: a slug that 404s or exposes no Follow button is simply skipped by the
 * follower (reason "no_follow_button_or_already") — never an error. The slugs
 * below are best-effort; treat this as the extension point and verify/expand as
 * Sebastian discovers relevant voices. Shared with fb_seed_follows.js.
 */

module.exports = [
  { name: "Maria Ressa", url: "https://www.facebook.com/maria.ressa" },
  { name: "Inday Espina-Varona", url: "https://www.facebook.com/indayvaronawrites" },
  { name: "Ellen Tordesillas", url: "https://www.facebook.com/ellen.tordesillas" },
  { name: "Vergel Santos", url: "https://www.facebook.com/verafiles" },
  { name: "Pinoy Ako Blog", url: "https://www.facebook.com/PinoyAkoBlog" },
  { name: " Nonoy Espina memorial / NUJP", url: "https://www.facebook.com/nujp1986" },
];
