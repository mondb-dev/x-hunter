'use strict';
/**
 * runner/lib/linkedin_plan.js — plan-first LinkedIn posting.
 *
 * Before any prose is written, Sebastian decides how THIS post should be shaped:
 * theme, structure, opening move, length, tone, and whether media earns its
 * place — from the source material, his measured technique track record, and his
 * own most recent posts (so consecutive posts don't share one skeleton: the old
 * fixed template produced question-hook / 3 paragraphs / closing-question every
 * time). The plan drives the compose prompt in linkedin_draft.js.
 *
 *   planPost({packText, perfSummary, recentPosts}) -> plan | null
 *   parsePlan(raw) -> plan | null                     (exported for tests)
 *
 * The media options offered are grounded in what the poster can actually do
 * (tools/helmstack-social LinkedIn engine): text-only, ONE image copied from a
 * source article's og:image (attributed), or a link-preview card (post ends with
 * the article URL). Video, documents, polls, carousels are NOT postable, so the
 * planner is never offered them.
 *
 * planPost returns null on any failure (LLM error, malformed JSON) — the drafter
 * falls back to the old fixed-template flow, so planning can never block posting.
 */

const { reason } = require('./compose');
const { TECHNIQUES } = require('./linkedin_performance');

const MEDIA = new Set(['none', 'image', 'link']);
const TECH_IDS = new Set(TECHNIQUES.map((t) => t.id));

/**
 * @param {object} input
 * @param {string} input.packText     source material the post will draw from
 * @param {string} [input.perfSummary]  measured technique track record (perf.summaryText())
 * @param {Array<{text:string, posted_at:string}>} [input.recentPosts]  last posted items, newest first
 * @returns {Promise<object|null>}
 */
async function planPost({ packText = '', perfSummary = '', recentPosts = [] } = {}) {
  const recent = (recentPosts || [])
    .filter((p) => p && p.text)
    .map((p, i) => `--- your post ${i + 1} (${(p.posted_at || '').slice(0, 10)}) ---\n${p.text.trim().slice(0, 700)}`)
    .join('\n\n');

  const prompt = `You are Sebastian Hunter deciding HOW to write your next LinkedIn post — the plan, not the prose. Your feed must read like a person thinking in public, not a template: if your recent posts all opened the same way, ran the same length, and ended on the same beat, break the pattern.

SOURCE MATERIAL the post will draw from:
${String(packText).slice(0, 6000)}

YOUR MEASURED TRACK RECORD (engagement by opening technique):
${perfSummary || '(no measured data yet)'}

YOUR MOST RECENT LINKEDIN POSTS — study their shape (opening move, paragraph rhythm, length, how they end) and choose a DIFFERENT shape where the material allows:
${recent || '(none posted yet)'}

FORMATS YOU CAN ACTUALLY POST — nothing else exists (no video, no documents, no polls, no carousels):
- "none": text only. The default; strongest when the argument carries itself.
- "image": one news photograph copied from a source article about your exact topic (its og:image, credited "via <source>"). Choose ONLY when such an article will plausibly carry a strong, on-topic photo — a generic or mismatched photo is worse than none.
- "link": end the post with one source article URL so LinkedIn renders a preview card. Good when the post leans on one specific piece readers should open.

OPENING TECHNIQUES you are A/B testing (use the id): question_hook, stat_hook, contrarian_hook, scene_hook — or "other" with your own opening move when none of these fits the material.

Decide the shape that best fits THIS material. Vary length honestly (a tight 120-word observation is often more organic than another 300-word essay). Do NOT default to ending on a question — end however the argument actually resolves.

Return ONLY a JSON object:
{
  "theme": "one line — the single argument of the post",
  "structure": "2-3 sentences: how it opens, how it moves, paragraph rhythm, and how it ENDS (question / flat claim / implication / example)",
  "opening_technique": "question_hook|stat_hook|contrarian_hook|scene_hook|other",
  "opening": "one line — the exact opening move for this post",
  "length_words": 180,
  "tone": "2-4 words",
  "media": "none|image|link",
  "media_rationale": "one line — why this media choice for this post"
}`;

  const raw = await reason(prompt, { maxTokens: 700, tag: 'linkedin_plan' });
  return parsePlan(raw);
}

/** Lenient parse + validation. Returns null if the output is unusable. */
function parsePlan(raw) {
  if (!raw) return null;
  const s = String(raw);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let p;
  try { p = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  if (!p || typeof p !== 'object') return null;

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const plan = {
    theme: str(p.theme),
    structure: str(p.structure),
    opening_technique: TECH_IDS.has(str(p.opening_technique)) ? str(p.opening_technique) : 'other',
    opening: str(p.opening),
    length_words: Math.min(350, Math.max(80, Number(p.length_words) || 200)),
    tone: str(p.tone) || 'measured, analytical',
    media: MEDIA.has(str(p.media)) ? str(p.media) : 'none',
    media_rationale: str(p.media_rationale),
  };
  // A plan without a structure or opening is no plan at all.
  if (!plan.structure || !plan.opening) return null;
  return plan;
}

module.exports = { planPost, parsePlan };
