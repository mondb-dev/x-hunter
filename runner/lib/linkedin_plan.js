'use strict';
/**
 * runner/lib/linkedin_plan.js — plan-first LinkedIn posting.
 *
 * The SHAPE of a post (opening technique, ending type, length bucket, media) is
 * assigned by the A/B controller (linkedin_performance.pickShape — explore/exploit
 * on measured engagement), NOT chosen by taste. This planner's job is to FIT the
 * assigned shape to the specific source material: pick the theme, write the
 * structural blueprint, and name the exact opening move — so each post reads
 * organically while the measurable dimensions stay a controlled experiment.
 *
 * The planner may OVERRIDE an assigned dimension only when the material genuinely
 * can't support it (e.g. media=image but no source article would carry an on-topic
 * photo; ending=question where a question would be hollow). Overrides carry a
 * reason, are logged, and the FINAL values are what gets recorded and measured —
 * so an override never pollutes the experiment's data.
 *
 *   planPost({packText, recentPosts, assignment}) -> plan | null
 *   parsePlan(raw, assignment) -> plan | null        (exported for tests)
 *
 * Media options are grounded in what the poster can actually do
 * (tools/helmstack-social): text-only, ONE image copied from a source article's
 * og:image (attributed), or a link-preview card (post ends with the article URL).
 * Video, documents, polls, carousels are NOT postable.
 *
 * planPost returns null on any failure (LLM error, malformed JSON) — the drafter
 * falls back to the fixed-template flow, so planning can never block posting.
 */

const { reason } = require('./compose');
const { TECHNIQUES, DIMENSIONS, LENGTH_WORDS, byId } = require('./linkedin_performance');

/**
 * @param {object} input
 * @param {string} input.packText     source material the post will draw from
 * @param {object} input.assignment   pickShape() output: {technique, ending, length, media, words, why}
 * @param {Array<{text:string, posted_at:string}>} [input.recentPosts]  last posted items, newest first
 * @returns {Promise<object|null>}
 */
async function planPost({ packText = '', assignment, recentPosts = [] } = {}) {
  if (!assignment) return null;
  const recent = (recentPosts || [])
    .filter((p) => p && p.text)
    .map((p, i) => `--- your post ${i + 1} (${(p.posted_at || '').slice(0, 10)}) ---\n${p.text.trim().slice(0, 700)}`)
    .join('\n\n');

  const tech = byId(assignment.technique);
  const [lo, hi] = assignment.words || LENGTH_WORDS[assignment.length] || [150, 250];

  const prompt = `You are Sebastian Hunter planning your next LinkedIn post — the plan, not the prose.

Your posting shape is a running A/B experiment: an explore/exploit controller assigned this post's test cell from your measured engagement data. Your job is to FIT this shape to the material below so the post reads like a person thinking in public — not to redesign the shape.

THIS POST'S ASSIGNED SHAPE (from measured data — honor it):
- opening technique: ${assignment.technique} — ${tech ? tech.instruction : ''}
- ending: ${assignment.ending} (question = close on a genuine question; claim = close on a flat declarative; implication = close on what follows if the pattern holds)
- length: ${assignment.length} (${lo}-${hi} words)
- media: ${assignment.media} ("none" = text only; "image" = one news photo copied from a source article about your exact topic, credited. Video/documents/polls do not exist for you. NEVER put a URL in the post body — an in-body link costs 45-55% of reach.)

You may override a dimension ONLY if this material genuinely cannot support it (e.g. media=image but no source article would carry a strong on-topic photo, or the assigned opening is impossible for every viable theme). List any override in "overrides" with the dimension, the value you used instead, and one line of reason. Overrides should be rare.

SOURCE MATERIAL the post will draw from:
${String(packText).slice(0, 6000)}

YOUR MOST RECENT LINKEDIN POSTS — even within the assigned shape, vary voice and rhythm so consecutive posts don't read templated:
${recent || '(none posted yet)'}

Return ONLY a JSON object:
{
  "theme": "one line — the single argument of the post",
  "topic": "1-3 word lowercase slug for what the post is about (e.g. 'philippine impeachment', 'platform moderation') — recorded for stats, reuse a slug you'd use for similar posts",
  "structure": "2-3 sentences: how it opens, how it moves, paragraph rhythm, and how it ends — consistent with the assigned shape",
  "opening": "one line — the exact opening move for this material",
  "length_words": ${Math.round((lo + hi) / 2)},
  "tone": "2-4 words",
  "media_rationale": "one line — how the assigned media serves this post (or why you overrode it)",
  "overrides": [{"dimension": "media", "value": "none", "reason": "..."}]
}
Use an empty overrides array when you honor the full assignment.`;

  const raw = await reason(prompt, { maxTokens: 700, tag: 'linkedin_plan' });
  return parsePlan(raw, assignment);
}

/** Lenient parse + validation; merges assignment with any legal overrides.
 *  Returns null if the output is unusable. */
function parsePlan(raw, assignment) {
  if (!raw || !assignment) return null;
  const s = String(raw);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let p;
  try { p = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!p || typeof p !== 'object') return null;

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  // Final shape = assignment, then legal overrides. 'other' is allowed for
  // technique only (that post simply contributes no technique sample).
  const shape = {
    technique: assignment.technique,
    ending: assignment.ending,
    length: assignment.length,
    media: assignment.media,
  };
  const overrides = [];
  for (const o of Array.isArray(p.overrides) ? p.overrides : []) {
    const dim = str(o && o.dimension);
    const value = str(o && o.value);
    if (!(dim in shape)) continue;
    const legal = DIMENSIONS[dim].includes(value) || (dim === 'technique' && value === 'other');
    if (!legal || value === shape[dim]) continue;
    shape[dim] = value;
    overrides.push({ dimension: dim, value, reason: str(o.reason) });
  }

  const [lo, hi] = LENGTH_WORDS[shape.length] || [150, 250];
  const plan = {
    ...shape,
    theme: str(p.theme),
    topic: str(p.topic).toLowerCase().slice(0, 40),
    structure: str(p.structure),
    opening: str(p.opening),
    length_words: Math.min(hi, Math.max(lo, Number(p.length_words) || Math.round((lo + hi) / 2))),
    tone: str(p.tone) || 'measured, analytical',
    media_rationale: str(p.media_rationale),
    overrides,
  };
  // A plan without a structure or opening is no plan at all.
  if (!plan.structure || !plan.opening) return null;
  return plan;
}

module.exports = { planPost, parsePlan };
