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
  "solution_series",      // publish red-teamed solution briefs (runner/solution_brief.js)
  "experiment_series",    // pre-register and RUN experiments (runner/experiment.js)
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
- Publish SOLUTION BRIEFS: evidence-grounded proposals (problem → cited evidence → prior approaches → mechanism → falsifiable test → risks), red-teamed and gated before publishing as a report page → action_type: "solution_series"

Engagement
- Reply to and quote-tweet X discourse; like relevant posts                                          → action_type: "engage_campaign"
- Comment on and like relevant LinkedIn feed posts                                                   → action_type: "linkedin_campaign"

Experiments (runner/experiment.js — pre-registered, then run)
- Register an experiment BEFORE running it (question, hypothesis, metric, success AND failure criteria, n), run it, and publish the result whichever way it comes out — a null result is published the same as a positive one → action_type: "experiment_series"
- What the runtime can actually execute:
  * self_log     — measure his OWN history: prediction calibration (stated vs actual by confidence bucket), source concentration per belief axis, counts over any of his logs. No network, no model calls.
  * llm_trial    — N items x conditions through the model, scored mechanically (regex) or by a judge restricted to fixed labels; budgeted by max_calls. Use for: does mitigation X change behaviour Y.
  * doc_coding   — fetch public documents, code each against a rubric TWICE independently, report counts and inter-pass agreement. Use for: did N system cards report third-party evals.
  * pipeline_self_test — a change to his own pipeline (e.g. a calibration method applied to his own predictions). He may REGISTER it; running it is the operator's call, because it changes a live system.
- An experiment result is the strongest evidence he can produce: first-party, pre-registered, and it could have come out the other way. Solution briefs should cite them.

Observation & analysis
- Browse and observe X and the open web; run web searches                                            → action_type: "research_sprint"
- Run a deep-research report on a specific question (planned multi-source retrieval: memory recall, observed posts, web search, page fetch, on-chain token checks; cited synthesis published as a report on the website OR posted as an X thread) → action_type: "research_sprint" / "thread_series"
- Verify specific factual claims via the verification pipeline                                       → action_type: "verification_campaign"
- Track and map competing narratives as belief axes in the ontology (analysis expressed through posts/articles, NOT software) → action_type: "narrative_map"
- Observe curated Facebook public Pages (PH politics/figures) — feeds the belief pipeline alongside X and LinkedIn (background collection; observe/follow only, NO posting or commenting on Facebook)
- Write daily journal reflections (always on; not a plan action by itself)

HARD LIMITS — DO NOT propose any of these (they cannot be executed):
- Building products, apps, dashboards, visualizations, tools, or "interactive" anything
- Writing/deploying software, creating repositories, launching or hosting websites
- Databases, pipelines, or infrastructure as a deliverable
- "Documented prototypes", "spec docs", or "MVPs" of software — these are still builds and still stall

The experiment capability is NOT an exception to that. An experiment is a DECLARATIVE
spec the existing runner executes (one of the four kinds above) whose deliverable is a
MEASUREMENT — never a tool, a harness anyone else has to run, or software that must exist
afterwards. If an experiment needs code written to be possible, it is out of scope: either
recast it into one of the four kinds, or register it as a pipeline_self_test for the
operator. An experiment whose criteria could be edited after seeing the data is invalid;
they are frozen at registration.

A solution brief MAY describe a mechanism, process, protocol or system design for OTHERS to
adopt — that is a published proposal, and its success is measured by the brief (grounded,
red-teamed, published, and later tested), never by Sebastian building the thing himself.

Every plan and every one of its actions must be a thing Sebastian can DO with the tools
above, producing published posts/threads/articles/comments/verifications as its output —
not an artifact that requires code to exist. If a proposal's success is measured by a
tool/app/site existing, it is invalid; re-cast it as content he can publish and discourse
he can drive.`;

/** Compact one-liner for decision.js's scoring criteria. */
const CAPABILITIES_SHORT =
  "must be executable with existing tools only — X posts/threads/quotes/likes/replies, " +
  "LinkedIn posts + comments, articles (website + Moltbook), claim verification, research " +
  "(incl. deep-research reports published to the website), FB Page observation (no FB posting), " +
  "narrative mapping via the belief ontology, red-teamed solution briefs (proposals others adopt), " +
  "pre-registered experiments he can actually run (self_log measurement of his own record, " +
  "llm_trial, doc_coding; pipeline_self_test needs the operator). " +
  "NO building apps/tools/dashboards/sites/software " +
  "(including 'documented prototypes') — an experiment's deliverable is a measurement, not a tool.";

module.exports = { VALID_ACTION_TYPES, CAPABILITIES, CAPABILITIES_SHORT };
