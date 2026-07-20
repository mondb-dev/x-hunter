"use strict";
/**
 * runner/image_style.js — Shared image generation style directive
 *
 * Single source of truth for all Imagen prompts in this project.
 * See docs/IMAGE_STYLE.md for the human-readable rules.
 *
 * Used by:
 *   runner/landmark/art.js    (landmark editorial covers)
 *   runner/article_art.js     (sprint article covers)
 */

/**
 * Combined pixel-art + editorial style directive.
 *
 * Pixel art is the medium. Editorial qualities (dramatic cinematic composition,
 * intentional color palette, atmospheric depth, strong focal subject) are layered
 * on top — the same way a magazine uses illustration instead of photography.
 *
 * Constraints that apply regardless of style:
 *   - Human figures: faceless silhouettes, posture conveys action
 *   - No flags, no national symbols, no insignia, no uniforms with markings
 *   - No text, no lettering, no numbers, no logos, no title cards
 */
const STYLE_DIRECTIVE = [
  // Medium
  "Pixel art illustration, handcrafted 16-bit/32-bit era aesthetic,",
  "chunky pixel clusters, visible pixel grid, crisp hard edges,",
  "limited but intentional color palette.",
  // Editorial layer
  "Editorial composition: dramatic cinematic framing, strong focal subject,",
  "atmospheric depth built from pixel color, deliberate tonal contrast,",
  "the visual clarity of a magazine cover rendered in pixel art.",
  // Prohibited — these constraints are absolute
  "NO TEXT OF ANY KIND — zero letters, zero words, zero numbers, zero labels, zero captions.",
  "No flags, no national symbols, no insignia, no uniforms with markings,",
  "no logos, no title cards, no UI elements, no speech bubbles.",
  "No visible faces — all figures are silhouettes or viewed from behind/distance.",
].join(" ");

/**
 * Negative prompt — always pass to Imagen alongside the main prompt.
 */
const NEGATIVE_PROMPT =
  "faces, facial features, flags, national symbols, insignia, uniform markings, " +
  "text, letters, numbers, logos, title cards, UI elements, speech bubbles, blurry anti-aliasing";

// Sebastian's canonical on-screen character, derived from his live LinkedIn
// avatar (operator decision 2026-07-20; reference copy at
// runner/assets/sebastian_character.png). Any depiction of Sebastian himself
// (the daily video series, future character appearances) MUST use this sheet;
// pair it with the reference image when the generator supports attachments.
// (The website pfp — robot with hunter fedora — remains the site favicon/pfp
// asset; it is NOT the character.)
const CHARACTER_DIRECTIVE =
  "Sebastian is a small, round, extremely fluffy bright grass-green baby chick " +
  "with soft fuzzy feathers, a tiny orange beak, and little orange feet, wearing " +
  "black rectangular pixelated 8-bit 'deal-with-it' sunglasses that sit slightly " +
  "tilted on his face. Deadpan, unbothered, quietly observing. Always the SAME " +
  "character — same green fluff, same pixel shades, same proportions (a chick " +
  "the size of a fist) in every appearance. Never humanoid, never a real animal " +
  "photo — stylized and consistent with the scene's art style.";

const CHARACTER_REFERENCE_IMAGE = require("path").join(__dirname, "assets", "sebastian_character.png");

module.exports = { STYLE_DIRECTIVE, NEGATIVE_PROMPT, CHARACTER_DIRECTIVE, CHARACTER_REFERENCE_IMAGE };
