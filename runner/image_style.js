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
  // Figures
  "Human figures as faceless silhouettes — no facial features, posture and tool in hand convey role.",
  // Prohibited
  "No faces, no flags, no national symbols, no insignia, no uniforms with markings,",
  "no text, no lettering, no numbers, no logos, no title cards, no UI elements.",
].join(" ");

/**
 * Negative prompt — always pass to Imagen alongside the main prompt.
 */
const NEGATIVE_PROMPT =
  "faces, facial features, flags, national symbols, insignia, uniform markings, " +
  "text, letters, numbers, logos, title cards, UI elements, speech bubbles, blurry anti-aliasing";

module.exports = { STYLE_DIRECTIVE, NEGATIVE_PROMPT };
