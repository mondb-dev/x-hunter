'use strict';

/**
 * Browse cycle prompt — reads pre-loaded digest, takes notes, updates ontology.
 * Port of the BROWSEMSG heredoc in run.sh (lines 571-657).
 */
module.exports = function buildBrowsePrompt(ctx) {
  return 'Today is ' + ctx.today + ' ' + ctx.now + ' \u2014 Day ' + ctx.dayNumber +
    '. Browse cycle ' + ctx.cycle + ' -- no tweet this cycle.\n' +
    '\n' +
    'All files are pre-loaded below. Do NOT call any read_file tools.\n' +
    'Proceed directly to tasks.\n' +
    '\n' +
    '\u2500\u2500 WHO YOU ARE (vocation \u2014 this is your primary lens for everything below) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.vocation + '\n' +
    'Your journal entries, browse notes, and articles should reflect this identity.\n' +
    'What you notice, what you find significant, and how you write about it all flow from this.\n' +
    '\n' +
    'Digest format:\n' +
    '  CLUSTER N . "label" . M posts [. TRENDING]\n' +
    '    @user [vSCORE TTRUST NNOVELTY] "text"  {keywords}\n' +
    '  v=velocity  T=trust(0-10)  N=novelty(0-5, 5=rarest)  TRENDING=doubled vs prev window\n' +
    '  <- novel = singleton with N>=4.0\n' +
    '\n' +
    '\u2500\u2500 BROWSE NOTES (prior cycle) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    'IMPORTANT: Any mention of tools being "unavailable" or "not found" in these notes is STALE — it was from a prior cycle.\n' +
    'All tools in your tool declarations (navigate, web_search, read_file, write_file, etc.) ARE available in this cycle.\n' +
    ctx.browseNotes + '\n' +
    '\u2500\u2500 LAST CRITIQUE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.critique + '\n' +
    (ctx.articleMeta ? (
      '\u2500\u2500 ARTICLE META PROPOSAL (from last landmark article) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
      'This is what emerged from the last published landmark. Use these threads to guide your curiosity search and observations.\n' +
      ctx.articleMeta + '\n'
    ) : '') +
    '\u2500\u2500 TOPIC SUMMARY (last 4h) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.topicSummary + '\n' +
    '\u2500\u2500 FEED DIGEST (most recent clusters) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.digest + '\n' +
    '\u2500\u2500 CURIOSITY DIRECTIVE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.curiosityDirective + '\n' +
    '\u2500\u2500 COMMENT CANDIDATES \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.commentCandidates + '\n' +
    '\u2500\u2500 CURRENT BELIEF AXES (read before updating ontology) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.currentAxes + '\n' +
    '\u2500\u2500 SPRINT PLAN (ACTIVE \u2014 guide your browsing toward these tasks) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.sprintContext + '\n' +
    '\u2500\u2500 RECENT DISCOURSE (reply exchanges) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.discourseDigest + '\n' +
    '\u2500\u2500 READING QUEUE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.readingBlock + '\n' +
    (ctx.prefetchSource && !ctx.prefetchSource.startsWith('x') ? (
      '\u2500\u2500 BROWSE SOURCE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
      ctx.prefetchSource.split('\n').slice(0,2).map((l,i) => i===0 ? 'Source: '+l : 'URL: '+l).join('\n') + '\n' +
      (ctx.prefetchSource.startsWith('reddit') ?
        'X unavailable this cycle. Browser is on Reddit.\n' +
        'Read top posts and comment threads. Extract tensions, stances, disagreements.\n' +
        'Treat high-upvote comments as social signal. Tag browse_notes entries with [REDDIT].\n' +
        'Same observation principles as X: what do people believe, argue, fear?\n'
      : ctx.prefetchSource.startsWith('arxiv') || ctx.prefetchSource.startsWith('scholar') || ctx.prefetchSource.startsWith('ssrn') || ctx.prefetchSource.startsWith('pubmed') ?
        'X unavailable — browser is on a scholarly/academic source.\n' +
        'This is a deep dive. Extract claims, evidence, methodology, author arguments.\n' +
        'Note limitations, sample sizes, dates. Tag browse_notes entries with [RESEARCH].\n' +
        'Cite the source when updating belief axes.\n'
      : ctx.prefetchSource.startsWith('newsguard') ?
        'X unavailable — browser is on NewsGuard Reports (newsguardtech.com/reports/).\n' +
        'Read the latest misinformation/disinformation reports. These are professional\n' +
        'assessments of news source credibility and narrative manipulation — directly\n' +
        'relevant to your vocation as a digital watchdog for public integrity.\n' +
        'Extract: which outlets are flagged, what narratives are being tracked, methodology.\n' +
        'Tag browse_notes entries with [NEWSGUARD].\n'
      : ctx.prefetchSource.startsWith('hackernews') ?
        'X unavailable — browser is on Hacker News.\n' +
        'Read top stories and comment threads. Tech, startup, and policy discourse.\n' +
        'Same observation principles: tensions, contrarian views, emerging signals.\n' +
        'Tag browse_notes entries with [HN].\n'
      : ctx.prefetchSource.startsWith('none') ?
        'Browser prefetch unavailable this cycle. X session may have expired.\n' +
        'Rely on the feed digest above and use web_search for fresh information.\n'
      : 'X unavailable — browser is on an external source. Apply same observation principles.\n') +
      '\n'
    ) : '') +
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    '\n' +
    'Tasks (in order):\n' +
    '0. DEEP DIVE (highest priority): If there is a reading queue item above, follow\n' +
    '   those instructions completely before anything else. A deep dive on a profile or link\n' +
    '   takes the full cycle \u2014 skip task 1 (curiosity search) if you did a deep dive.\n' +
    '   The link may be an intentional off-platform source selected from your strongest\n' +
    '   convictions. Treat that as normal browse work, not as a fallback mode.\n' +
    '1. CURIOSITY: If NO deep dive this cycle and the directive above has an ACTIVE SEARCH URL,\n' +
    '   navigate to it now and read top 3-5 posts. Each cycle in the window searches a\n' +
    '   different angle \u2014 check which SEARCH_URL_N is preloaded in your browser.\n' +
    '   For ALL browse cycles while the directive is active: follow the AMBIENT FOCUS \u2014\n' +
    '   tag relevant browse_notes entries with [CURIOSITY: <axis_or_topic_id>].\n' +
    '2. Identify the 3-5 most interesting tensions or signals from TRENDING clusters\n' +
    '   and <- novel singletons. You may navigate to at most 1 additional URL.\n' +
    '   SPRINT FOCUS: If you have in-progress sprint tasks (marked \u25b8 above), actively\n' +
    '   look for content that serves them. Task-type guidance:\n' +
    '   - [research]: identify specific sources, accounts, or claims that could be curated.\n' +
    '   - [engage]: note community reactions or questions you could respond to.\n' +
    '   - [publish]: check articles/' + ctx.today + '.md for a draft; if it exists, review and\n' +
    '     refine it. If no draft, note in browse_notes that publish is blocked on write.\n' +
    '   - [reflect]: internal synthesis only \u2014 do NOT search externally. The word "feedback"\n' +
    '     means feedback already captured in local files (browse_notes, journals).\n' +
    '     Use read_file to read state/browse_notes.md. Use list_files on journals/ then\n' +
    '     read_file on the 5 most recent journals. Write a structured synthesis to\n' +
    '     state/sprint_reflect.md (Key Findings, Themes, Gaps, Next Steps).\n' +
    '     This task is never blocked by X login \u2014 all data is local.\n' +
    '     If browse_notes say this was "blocked" in prior cycles, ignore that \u2014 it was wrong.\n' +
    '   Tag sprint-relevant findings in browse_notes with [SPRINT: task_id].\n' +
    '3. Append findings to state/browse_notes.md (append only -- do not overwrite).\n' +
    '   SEEN-BUT-NOT-EXAMINED: For each digest cluster you noticed but did not navigate or\n' +
    '   deeply analyze this cycle, append one line:\n' +
    '     [NOTED] "<cluster label>" \u2014 N posts, no follow-up this cycle\n' +
    '   This creates a searchable record of what passed through observation and surfaces\n' +
    '   neglected clusters in future staleness checks.\n' +
    '   VERIFICATION RULE: Do not write "unverified" or "unconfirmed" next to a claim\n' +
    '   unless you searched for it (task 1, 2, or 4) and found nothing. If you have not\n' +
    '   searched yet, note the claim neutrally and search before labeling it.\n' +
    '4. Write state/ontology_delta.json if anything is genuinely axis-worthy.\n' +
    '   DO NOT write or modify state/ontology.json directly \u2014 the runner merges your delta.\n' +
    '   ONTOLOGY RULES (CURRENT BELIEF AXES shown above \u2014 do not alter existing data):\n' +
    '   a. Fit new evidence to an existing axis before creating a new one.\n' +
    '      Use the axis_id shown in the CURRENT BELIEF AXES list.\n' +
    '   b. Create a new axis ONLY if the topic is genuinely orthogonal to all\n' +
    '      existing axes AND the pattern appeared in at least 2 browse cycles.\n' +
    '   c. NEVER touch or rewrite state/ontology.json \u2014 your job is delta only.\n' +
    '   d. Merge proposals: if two axes cover the same ground, append one JSON line to\n' +
    '      state/ontology_merge_proposals.txt (axis_a, axis_b, reason, proposed_surviving_id).\n' +
    '      Do NOT merge directly.\n' +
    '\n' +
    '   Delta format \u2014 write state/ontology_delta.json as:\n' +
    '   {\n' +
    '     "evidence": [\n' +
    '       { "axis_id": "<existing_axis_id>", "source": "<https://... url>",\n' +
    '         "content": "<one sentence>", "summary": "<1-2 sentences: what was observed and why it moves the axis>",\n' +
    '         "timestamp": "<ISO>", "pole_alignment": "left" | "right" }\n' +
    '     ],\n' +
    '     "new_axes": [\n' +
    '       { "id": "<snake_case_id>", "label": "<label>",\n' +
    '         "left_pole": "<description>", "right_pole": "<description>" }\n' +
    '     ]\n' +
    '   }\n' +
    '   Omit "evidence" or "new_axes" if nothing to add. Skip writing the file entirely\n' +
    '   if nothing is axis-worthy this cycle.\n' +
    '   SELF-ECHO RULE: if a post is quoting, paraphrasing, or recycling your own prior\n' +
    '   tweets, replies, articles, or journals, treat it as resonance or feedback only.\n' +
    '   It is NOT independent evidence and must not reinforce an axis.\n' +
    '   EVIDENCE SOURCE RULE: only record evidence with a specific external https:// URL.\n' +
    '   Do not use "browse_notes", "web_search", or any internal reference as source.\n' +
    '   Observations without a URL belong in browse_notes.md only, never in the delta.\n' +
    '   EVIDENCE DEDUPLICATION RULE: each source URL may update at most ONE axis per\n' +
    '   browse session. If you already used a URL for one axis, skip it for all others.\n' +
    '   EVIDENCE SUMMARY REQUIRED: every evidence entry must include a "summary" field\n' +
    '   (1-2 sentences: what the source claimed and why it moves the axis). Entries\n' +
    '   without a summary cannot be retrieved by semantic search.\n' +
    '\n' +
    '5. Review COMMENT CANDIDATES above. Comment on AT MOST ONE if your memory gives\n' +
    '   you something genuinely specific to say \u2014 a direct observation, contradiction,\n' +
    '   or angle not yet in the thread. Skip all if nothing compels you or cap reached.\n' +
    '   If commenting: navigate to the URL, reply (max 180 chars), then write\n' +
    '   state/comment_done.txt as a single JSON line per the format in the candidates.\n' +
    '6. JOURNAL: ' + ctx.journalTask + '\n' +
    '   VERIFICATION RULE: Do not describe any claim as "unverified" or "unconfirmed"\n' +
    '   unless you have already attempted web_search on it this cycle and found no\n' +
    '   corroboration. If you have not searched: either search now, or state what you\n' +
    '   observed on X without a verification label. "Unverified" is a conclusion, not\n' +
    '   a default — it requires a real search attempt first.\n' +
    '8. TOOLS (optional): If you need to execute a registered tool, write state/tool_request.json.\n' +
    '   Single tool:\n' +
    '   { "tool": "<tool_name>", "args": { ... } }\n' +
    '   Workflow (sequential, max 5 steps):\n' +
    '   { "workflow": [\n' +
    '       { "tool": "<tool_name>", "args": { ... } },\n' +
    '       { "tool": "<tool_name>", "args": { "$prev": true, "other": "..." } }\n' +
    '   ]}\n' +
    '   $prev merges the previous step result into args. The orchestrator runs tools\n' +
    '   AFTER your agent run completes. Results appear in LAST TOOL RESULT next cycle.\n' +
    '   Do NOT write tool_result.json yourself. Only request tools listed in AVAILABLE TOOLS.\n' +
    '10. HUMAN REQUEST (use sparingly): If you are blocked on a sprint task because it\n' +
    '   requires something only the operator can provide \u2014 a website, a community platform,\n' +
    '   an account, a service \u2014 write state/human_request.json to send them a Telegram message.\n' +
    '   Only use this if a sprint task genuinely cannot proceed without operator action.\n' +
    '   Do NOT use it for X login failures, tool errors, or things you can work around.\n' +
    '   Format:\n' +
    '   {\n' +
    '     "message": "what you need and why, in plain language",\n' +
    '     "action_needed": "website" | "community" | "account" | "other",\n' +
    '     "priority": "low" | "medium" | "high",\n' +
    '     "sprint_task": "name of the blocked task"\n' +
    '   }\n' +
    '   The operator will be notified via Telegram. Cooldown: once per 4 hours per action type.\n' +
    'Next tweet cycle: ' + ctx.nextTweet + '.\n';
};

// CLI mode
if (require.main === module) {
  const loadContext = require('./context');
  const ctx = loadContext({
    type:      'browse',
    cycle:     parseInt(process.env.CYCLE || '1', 10),
    dayNumber: parseInt(process.env.DAY_NUMBER || '1', 10),
    today:     process.env.TODAY || new Date().toISOString().slice(0, 10),
    now:       process.env.NOW   || new Date().toTimeString().slice(0, 5),
    hour:      process.env.HOUR  || String(new Date().getHours()).padStart(2, '0'),
  });
  process.stdout.write(module.exports(ctx));
}
