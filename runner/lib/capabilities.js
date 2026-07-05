"use strict";
/**
 * runner/lib/capabilities.js — the single source of truth for what Sebastian can
 * actually DO. Planning (ponder → deep_dive → decision) must ground every plan
 * to these tools/modules: a plan is only valid if it can be executed end-to-end
 * with the capabilities below, no new code or external software required.
 *
 * This exists because plans used to drift into "build a web tool / dashboard /
 * visualization" territory that the runtime cannot execute — those plans then
 * stall at 0 tasks done. Keep this list accurate as modules are added/removed.
 */

/** Machine-checkable set of allowed plan action types. */
const VALID_ACTION_TYPES = [
  "thread_series",        // X: original tweets / multi-tweet threads
  "article_series",       // long-form articles (website + Moltbook)
  "verification_campaign",// verify specific claims, post the results
  "engage_campaign",      // X engagement: proactive replies, quote-tweets, likes
  "linkedin_campaign",    // LinkedIn: long-form posts + feed engagement (comment/like)
  "research_sprint",      // directed research/browse toward a topic
  "narrative_map",        // map/track a narrative cluster via posts + belief ontology
];

/**
 * Human-readable capability manifest injected into planning prompts. Describes
 * exactly what Sebastian can do (and, explicitly, cannot) so the LLM proposes
 * only executable plans.
 */
const CAPABILITIES = `## SEBASTIAN'S AVAILABLE TOOLS & MODULES (plans must use ONLY these)

Publishing
- Post tweets, multi-tweet threads, quote-tweets, predictions, and signal/verification posts on X  → action_type: "thread_series" / "verification_campaign"
- Publish long-form articles in Markdown to the website + Moltbook                                   → action_type: "article_series"
- Publish long-form posts on LinkedIn (professional, systemic framing)                               → action_type: "linkedin_campaign"

Engagement
- Reply to and quote-tweet X discourse; like relevant posts                                          → action_type: "engage_campaign"
- Comment on and like relevant LinkedIn feed posts                                                   → action_type: "linkedin_campaign"

Observation & analysis
- Browse and observe X and the open web; run web searches                                            → action_type: "research_sprint"
- Verify specific factual claims via the verification pipeline                                       → action_type: "verification_campaign"
- Track and map competing narratives as belief axes in the ontology (analysis expressed through posts/articles, NOT software) → action_type: "narrative_map"
- Write daily journal reflections (always on; not a plan action by itself)

HARD LIMITS — DO NOT propose any of these (they cannot be executed):
- Building products, apps, dashboards, visualizations, tools, or "interactive" anything
- Writing/deploying software, creating repositories, launching or hosting websites
- Databases, pipelines, or infrastructure as a deliverable
- "Documented prototypes", "spec docs", or "MVPs" of software — these are still builds and still stall

Every plan and every one of its actions must be a thing Sebastian can DO with the tools
above, producing published posts/threads/articles/comments/verifications as its output —
not an artifact that requires code to exist. If a proposal's success is measured by a
tool/app/site existing, it is invalid; re-cast it as content he can publish and discourse
he can drive.`;

/** Compact one-liner for decision.js's scoring criteria. */
const CAPABILITIES_SHORT =
  "must be executable with existing tools only — X posts/threads/quotes/likes/replies, " +
  "LinkedIn posts + comments, articles (website + Moltbook), claim verification, research, " +
  "narrative mapping via the belief ontology. NO building apps/tools/dashboards/sites/software " +
  "(including 'documented prototypes').";

module.exports = { VALID_ACTION_TYPES, CAPABILITIES, CAPABILITIES_SHORT };
