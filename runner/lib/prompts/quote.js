'use strict';

/**
 * Quote cycle prompt — find and quote-tweet one post.
 * Port of the QUOTEMSG heredoc in run.sh (lines 780-833).
 */
module.exports = function buildQuotePrompt(ctx) {
  return 'Today is ' + ctx.today + ' ' + ctx.now + '. Quote cycle ' + ctx.cycle +
    ' -- find one post worth quoting.\n' +
    '\n' +
    'Your strongest belief axes (what you actually think matters):\n' +
    ctx.topAxes + '\n' +
    '\n' +
    'Already quoted source tweets (do NOT quote these again):\n' +
    ctx.quotedSources + '\n' +
    '\n' +
    '\u2500\u2500 FEED DIGEST (most recent clusters) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.digest + '\n' +
    '\u2500\u2500 SPRINT PLAN (prefer quotes that advance your active tasks) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.sprintContext + '\n' +
    '\u2500\u2500 MEMORY RECALL (your past observations — verify before citing) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.memoryRecall + '\n' +
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    '\n' +
    'Tasks:\n' +
    '1. From the digest above, identify 2-3 candidate posts that touch your belief axes.\n' +
    '   SPRINT PRIORITY: If you have in-progress sprint tasks (\u25b8), prefer quoting posts\n' +
    '   that directly serve those tasks \u2014 e.g. a source worth curating, a claim worth\n' +
    '   analyzing for the Veritas Lens, or community discussion to engage with.\n' +
    '   HARD SKIP (never quote these): questions or replies directed AT you (@SebastianHunts),\n' +
    '   retweets with no original text, posts that are only a URL, posts shorter than 15 words.\n' +
    '   Candidates must be making a real substantive claim you can engage with.\n' +
    '\n' +
    '2. Navigate to the best candidate URL in your browser. Read the actual tweet and its visible replies.\n' +
    '   Do not rely on the digest summary \u2014 you need to see what the tweet actually says in full.\n' +
    '   While reading, ask: does this push left or right on one of my axes? Does it confirm my prior,\n' +
    '   challenge it, or reveal a nuance I had not seen? That specific tension is your angle.\n' +
    '   If after reading it is not interesting enough to quote, navigate to your second candidate.\n' +
    '\n' +
    '3. Write your quote commentary ONLY after you have read the tweet in the browser.\n' +
    '   GROUNDING RULE (AGENTS.md §18): If your commentary references ANY past observation\n' +
    '   or prior belief ("I previously noted...", "My Day X analysis..."), you MUST verify it\n' +
    '   against what you actually saw. If you cannot cite a specific date, write from what you\n' +
    '   see in the tweet RIGHT NOW — do not invent a history.\n' +
    '   NOT acceptable: generic belief statement that could apply to any tweet.\n' +
    '   NOT acceptable: "this claim conflates X", "demands scrutiny", "risks premature judgment" \u2014 press release language.\n' +
    '   NOT acceptable: internal metrics in the tweet \u2014 no "conf 95%", "score 0.40", "(confidence: X)".\n' +
    '   ACCEPTABLE: a direct response to what this specific tweet actually says, from your position on the axis.\n' +
    '   The reader must be able to see why THIS tweet provoked THIS response.\n' +
    '   HARD LIMIT: Max 240 characters. Count them. If it is over 240 when you re-read, CUT WORDS\n' +
    '   until it fits. Example of 240 chars: "Iran claims Kharg Island is off-limits. But three\n' +
    '   analysts I follow say the US has already mapped extraction routes. The gap between rhetoric\n' +
    '   and operational reality keeps widening." \u2014 that is exactly 228 chars. Aim for that density.\n' +
    '   VOICE: Write like a person, not an analyst. Short, direct sentences. Say what the tweet\n' +
    '   claims, then say what you actually think about it. If it sounds like a report, rewrite it.\n' +
    '\n' +
    '4. Write state/quote_draft.txt (overwrite):\n' +
    '   Line 1: the source tweet URL\n' +
    '   Lines 2+: your quote commentary (max 240 chars).\n' +
    '   Do NOT write to state/posts_log.json \u2014 the runner owns that file.\n' +
    '\n' +
    '5. Done \u2014 do not navigate further. The runner posts the quote.\n';
};

// CLI mode
if (require.main === module) {
  const loadContext = require('./context');
  const ctx = loadContext({
    type:      'quote',
    cycle:     parseInt(process.env.CYCLE || '1', 10),
    dayNumber: parseInt(process.env.DAY_NUMBER || '1', 10),
    today:     process.env.TODAY || new Date().toISOString().slice(0, 10),
    now:       process.env.NOW   || new Date().toTimeString().slice(0, 5),
    hour:      process.env.HOUR  || String(new Date().getHours()).padStart(2, '0'),
  });
  process.stdout.write(module.exports(ctx));
}
