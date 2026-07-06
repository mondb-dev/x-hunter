#!/usr/bin/env node
/**
 * runner/linkedin_draft.js — generate a LinkedIn post draft for Sebastian.
 *
 * LinkedIn posting needs a content source (unlike tweets, which the TWEET cycle
 * writes). This pulls a collective content pack across ALL of Sebastian's signals
 * (journal, X posts, engagements, articles, collected news, live X timeline, live
 * LinkedIn feed, live web search — see lib/content_sources.js) and synthesises ONE
 * long-form LinkedIn post using a LinkedIn-specific placement strategy.
 *
 * Skips (exit 0, no write) if a pending draft already exists.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./lib/config");
const { buildContentPack } = require("./lib/content_sources");

const ROOT = path.resolve(__dirname, "..");
const DRAFT = path.join(config.STATE_DIR, "linkedin_draft.txt");
const VOCATION = path.join(ROOT, "vocation.md");
const log = (m) => console.log(`[linkedin_draft] ${m}`);

// LinkedIn is a professional network, not X. The placement strategy shapes the
// same underlying vocation into content that lands with LinkedIn's audience
// (media, policy, comms, tech, information-integrity professionals).
const LINKEDIN_STRATEGY = `LINKEDIN PLACEMENT STRATEGY — how to shape this content for LinkedIn (NOT X):
- Audience: professionals in media, policy, communications, technology, and information integrity. They reward analysis and credibility, not hot takes.
- Pick ONE theme that recurs across the source material below (cross-source grounding beats a single feed). Prefer a theme where the journal, engagements, and live feeds point the same way.
- Frame it as a SYSTEMIC insight, not a reaction: connect a specific, current example (name the actor, the claim, the number, the event — from the sources) to the broader mechanism of strategic narrative construction / manufactured consent. Move from the concrete instance to the pattern.
- Offer something useful: a lens, a distinction, or a question a professional could apply to their own field. Sebastian's value is making manipulation legible, not scoring points.
- Format: first person, 150-350 words, 2-4 short plain paragraphs. Measured and analytical in tone.
- NO hashtags, NO emojis, NO thread markers ("1/n", "🧵"), NO X-style punchy one-liners. Open with the insight (no "Excited to share"), close with a genuine question that invites professional discussion.`;

(async () => {
  if (fs.existsSync(DRAFT)) {
    const existing = fs.readFileSync(DRAFT, "utf-8").trim();
    if (existing && existing !== "SKIP") { log("pending draft exists — not overwriting"); process.exit(0); }
  }

  let vocation = "";
  try { vocation = fs.readFileSync(VOCATION, "utf-8").slice(0, 1500); } catch {}

  // Live sources (X timeline, LinkedIn feed, web search) need HelmStack; best-effort.
  let client = null;
  try {
    const { HelmStackClient } = require("../tools/helmstack-social/src");
    if (process.env.HELMSTACK_AUTH_TOKEN) client = new HelmStackClient();
  } catch {}

  const pack = await buildContentPack({ client });
  const nSources = Object.values(pack.sources).filter(Boolean).length;
  log(`content pack: ${nSources} live/file source(s), theme seed "${pack.query}"`);
  if (!pack.text.trim()) { log("no source material — skipping"); process.exit(0); }

  const { compose } = require("./lib/compose");
  const prompt =
`You are Sebastian Hunter writing a LinkedIn post. Your vocation and voice:
${vocation}

${LINKEDIN_STRATEGY}

SOURCE MATERIAL (draw the theme from across these — cite specifics):
${pack.text}

Write ONE original LinkedIn post following the strategy above. Return ONLY the post text.`;

  try {
    const raw = await compose(prompt, { maxTokens: 1000, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "linkedin_draft" });
    const text = (raw || "").trim().replace(/^["']|["']$/g, "");
    if (!text || text.length < 120) { log("generation too short — skipping"); process.exit(0); }

    // Coherence gate (local): a LinkedIn post may cite several examples but must
    // advance ONE argument — reject a grab-bag that jams unrelated stories together.
    try {
      const { refine } = require("./lib/refine");
      const result = await refine(
        { text },
        {
          surface: "LinkedIn post",
          goal: "One coherent argument about narrative construction. It may cite multiple examples, but they must all serve the same single thesis — not a grab-bag of unrelated stories.",
          minSpecificity: 2,
          useRecall: true,
          log: (m) => console.log(m),
        }
      );
      if (result.verdict === "reject") {
        log(`coherence gate REJECT — not writing draft. ${result.issues.join("; ")}`);
        process.exit(0);
      }
      log(`coherence gate: ${result.verdict}`);
    } catch (e) {
      log(`coherence gate unavailable (${e.message}) — proceeding`);
    }

    fs.writeFileSync(DRAFT, text);
    log(`wrote draft (${text.length} chars)`);
    process.exit(0);
  } catch (err) {
    log(`generation failed: ${err.message}`);
    process.exit(0);
  }
})();
