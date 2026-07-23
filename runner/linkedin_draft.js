#!/usr/bin/env node
/**
 * runner/linkedin_draft.js — generate a LinkedIn post draft for Sebastian.
 *
 * LinkedIn posting needs a content source (unlike tweets, which the TWEET cycle
 * writes). This pulls a collective content pack across ALL of Sebastian's signals
 * (journal, X posts, engagements, articles, collected news, live X timeline, live
 * LinkedIn feed, live web search — see lib/content_sources.js), PLANS the post's
 * shape first (lib/linkedin_plan: structure, opening, length, tone, media — so
 * posts read organically instead of stamped from one template), then composes
 * the prose to that plan.
 *
 * Enqueues the finished post into the channel-agnostic outbox (lib/outbox) as a
 * pending 'linkedin' item; linkedin_post.js drains it. No more single-file draft
 * (state/linkedin_draft.txt) that could deadlock when a draft failed a gate.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./lib/config");
const { buildContentPack } = require("./lib/content_sources");

const outbox = require("./lib/outbox");
const perf = require("./lib/linkedin_performance");

const ROOT = path.resolve(__dirname, "..");
const VOCATION = path.join(ROOT, "vocation.md");
const log = (m) => console.log(`[linkedin_draft] ${m}`);

// LinkedIn is a professional network, not X. The VOICE rules below are always
// enforced; the SHAPE of each post (structure, opening, length, ending, media)
// is decided per-post by the plan stage (lib/linkedin_plan) so consecutive
// posts don't share one skeleton. The fixed-format lines survive only in the
// fallback template used when planning fails.
const LINKEDIN_VOICE = `LINKEDIN PLACEMENT — how to shape this content for LinkedIn (NOT X):
- Audience: professionals in media, policy, communications, technology, and information integrity. They reward analysis and credibility, not hot takes.
- Pick ONE theme that recurs across the source material below (cross-source grounding beats a single feed). Prefer a theme where the journal, engagements, and live feeds point the same way.
- Frame it as a SYSTEMIC insight, not a reaction: connect a specific, current example (name the actor, the claim, the number, the event — from the sources) to the broader mechanism of strategic narrative construction / manufactured consent. Move from the concrete instance to the pattern.
- Offer something useful: a lens, a distinction, or a question a professional could apply to their own field. Sebastian's value is making manipulation legible, not scoring points.
- First person. NO hashtags, NO emojis, NO thread markers ("1/n", "🧵"), NO X-style punchy one-liners, no "Excited to share".`;

// Fallback shape when the plan stage is unavailable — the old fixed template.
const FALLBACK_FORMAT = `- Format: 150-350 words, 2-4 short plain paragraphs. Measured and analytical in tone. Open with the insight, close with a genuine question that invites professional discussion.`;

(async () => {
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

  // Ground the post in Sebastian's actual belief structure + prior synthesis,
  // not just the raw signal pack (which only used the top axis label as a
  // web-search seed). Both best-effort.
  let axesBlock = "";
  try { axesBlock = require("./lib/prompts/context").formatTopAxes(); } catch {}
  let recallBlock = "";
  try { recallBlock = await require("./lib/recall").recallText(pack.query, { maxChars: 1200 }); } catch {}

  const perfSummary = perf.summaryText();

  // Shape is an A/B experiment: the explore/exploit controller (pickShape)
  // assigns this post's test cell across every measured dimension — opening,
  // ending, length, media. The plan stage then FITS that assignment to the
  // material (theme, structural blueprint, exact opening move), overriding a
  // dimension only when the material can't support it (override recorded, so
  // measurement always reflects what was actually posted).
  const assignment = perf.pickShape();
  log(`shape assignment: ${["technique","ending","length","media"].map((d) => `${d}=${assignment[d]} [${assignment.why[d]}]`).join(", ")}`);

  let plan = null;
  try {
    const { planPost } = require("./lib/linkedin_plan");
    plan = await planPost({
      packText: pack.text,
      assignment,
      recentPosts: outbox.recentPosted("linkedin", { limit: 3 }),
    });
  } catch (e) { log(`plan stage failed (${e.message}) — using fallback template`); }

  let technique = null;
  if (plan) {
    for (const o of plan.overrides) log(`plan OVERRIDE: ${o.dimension} → ${o.value} (${o.reason})`);
    log(`plan: ${plan.technique}/${plan.ending}/${plan.length}/${plan.media} ~${plan.length_words}w${plan.media_rationale ? ` — ${plan.media_rationale}` : ""}`);
    log(`plan structure: ${plan.structure}`);
  } else {
    technique = perf.pickTechnique();
    log(`no plan — fallback technique: ${technique.id} (${technique.label})`);
  }

  const ENDING_DIRECTIVE = {
    question: "END on a genuine question that invites professional discussion.",
    claim: "END on a flat declarative claim — no closing question.",
    implication: "END on the implication — what follows if this pattern holds. No closing question.",
  };
  const shapeBlock = plan
    ? `YOUR POST PLAN — the shape comes from your measured A/B experiment; the fit to this material is yours. Follow it:
- Theme: ${plan.theme || "(as implied by the structure)"}
- Structure: ${plan.structure}
- Opening move: ${plan.opening}
- Length: about ${plan.length_words} words
- Tone: ${plan.tone}
- ${ENDING_DIRECTIVE[plan.ending] || ENDING_DIRECTIVE.claim}`
    : `${FALLBACK_FORMAT}\n\nOPENING TECHNIQUE TO USE FOR THIS POST: ${technique.instruction}`;

  const prompt =
`You are Sebastian Hunter writing a LinkedIn post. Your vocation and voice:
${vocation}

${LINKEDIN_VOICE}

${shapeBlock}
${perfSummary ? `\n${perfSummary}\n` : ""}
YOUR CURRENT BELIEF AXES (your mapped positions — the post must argue consistently with these; lean on the highest-confidence axis that fits the theme):
${axesBlock || "(unavailable)"}

RELEVANT MEMORY (your prior synthesis / observations on this theme — build on it, do not contradict or repeat it verbatim):
${recallBlock || "(none)"}

SOURCE MATERIAL (draw the theme from across these — cite specifics):
${pack.text}

Write ONE original LinkedIn post following the voice rules and the ${plan ? "post plan" : "format and opening technique"} above. Return ONLY the post text.`;

  try {
    const raw = await compose(prompt, { maxTokens: 1000, model: "gemini-2.5-flash", thinkingBudget: 0, tag: "linkedin_draft" });
    let text = (raw || "").trim().replace(/^["']|["']$/g, "");
    if (!text || text.length < 120) { log("generation too short — skipping"); process.exit(0); }

    // Shared outbound gate: voice_filter (was missing on LinkedIn posts) +
    // fact-check (stale officeholder titles / datable claims → correct or skip).
    const { passOutbound } = require("./lib/outbound_gates");
    const gated = await passOutbound(text, { gates: ["voice", "factcheck"], tag: "linkedin_draft" });
    if (!gated.ok) { log(`outbound gate rejected: ${gated.reason} — skipping`); process.exit(0); }
    if (gated.text.length < 120) { log("post too short after gating — skipping"); process.exit(0); }
    text = gated.text;
    log("outbound gate: pass");

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

    // Media follows the plan (no plan → old behavior of trying an image).
    //   image → linkedin_post.js copies the lead source's og:image + attributes it.
    //   link  → append the lead source URL so LinkedIn renders a preview card.
    //   none  → clean text-only post.
    // pickLeadSource coherence-gates the source against the post either way; a
    // miss just means text-only. IMAGE_AUTO_TRIGGER=0 disables all media.
    let imageSource = null;
    let linkSource = null;
    // The A/B assignment decides media, NOT the plan. The plan used to win here
    // and it vetoed the image arm every time on speculation ("no photographable
    // news event ... unlikely to have strong news imagery") — without ever
    // fetching anything. Two facts show that veto was wrong: X pulled a perfectly
    // good og:image from an Inquirer article on the SAME impeachment story that
    // day, and 13/13 tracked LinkedIn posts came out media=none, so the image arm
    // sat at 0 samples and the A/B could never learn whether images help.
    // pickLeadSource below is the empirical arbiter — it actually fetches and
    // coherence-gates the source, and a miss falls back to text-only anyway, so
    // letting the assignment through costs nothing in quality.
    const wantMedia = (assignment && assignment.media) || (plan ? plan.media : "image");
    if (plan && plan.media !== wantMedia) log(`media: using A/B assignment "${wantMedia}" over plan "${plan.media}"${plan.media_rationale ? ` (plan said: ${String(plan.media_rationale).slice(0, 90)})` : ""}`);
    if (process.env.IMAGE_AUTO_TRIGGER !== "0" && wantMedia !== "none") {
      try {
        const { pickLeadSource } = require("./lib/lead_source_image");
        const lead = await pickLeadSource(text, pack.text);
        if (lead && wantMedia === "image") { imageSource = lead.url; log(`image source set: ${lead.source} (${lead.url})`); }
        else if (lead && wantMedia === "link") { linkSource = lead.url; text = `${text}\n\n${lead.url}`; log(`link preview set: ${lead.source} (${lead.url})`); }
        else log(`no coherent lead source for media=${wantMedia} — posting text only`);
      } catch (e) { log(`media auto-trigger skipped: ${e.message}`); }
    }

    const { id, deduped } = outbox.enqueue({ channel: "linkedin", kind: "post", text, meta: {
      cycle: Number.parseInt(process.env.CYCLE_NUMBER || "", 10) || null,
      technique: plan ? plan.technique : technique.id,
      ...(plan ? { planned: true, ending: plan.ending, length: plan.length, media: plan.media, topic: plan.topic, structure: plan.structure } : {}),
      ...(imageSource ? { image_source: imageSource } : {}),
      ...(linkSource ? { link_source: linkSource } : {}),
    } });
    log(deduped ? `identical post already queued (outbox #${id}) — not re-queuing` : `enqueued post to outbox #${id} (${text.length} chars)`);
    process.exit(0);
  } catch (err) {
    log(`generation failed: ${err.message}`);
    process.exit(0);
  }
})();
