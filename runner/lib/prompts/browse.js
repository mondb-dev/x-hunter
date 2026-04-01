'use strict';

/**
 * Browse cycle prompt — reads pre-loaded digest, takes notes, updates ontology.
 * Port of the BROWSEMSG heredoc in run.sh (lines 571-657).
 *
 * Two modes:
 *   - Normal browse: feed observation, curiosity search, ontology updates
 *   - Silent-hours sprint: sprint work is PRIMARY when feed is stale (UTC 23-07)
 */

// ── Context preamble (shared between normal and sprint modes) ─────────────

function buildPreamble(ctx) {
  const mode = (ctx.isSilentHours && ctx.hasActiveSprint) ? ' [SPRINT WORK MODE]' : '';
  return 'Today is ' + ctx.today + ' ' + ctx.now + ' \u2014 Day ' + ctx.dayNumber +
    '. Browse cycle ' + ctx.cycle + ' -- no tweet this cycle.' + mode + '\n' +
    '\n' +
    'All files are pre-loaded below. Do NOT call any read_file tools.\n' +
    'Proceed directly to tasks.\n' +
    '\n' +
    'Digest format:\n' +
    '  CLUSTER N . "label" . M posts [. TRENDING]\n' +
    '    @user [vSCORE TTRUST NNOVELTY] "text"  {keywords}\n' +
    '  v=velocity  T=trust(0-10)  N=novelty(0-5, 5=rarest)  TRENDING=doubled vs prev window\n' +
    '  <- novel = singleton with N>=4.0\n' +
    '\n' +
    '\u2500\u2500 BROWSE NOTES (recent) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.browseNotes + '\n' +
    '\u2500\u2500 LAST CRITIQUE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.critique + '\n' +
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
    '\u2500\u2500 API PREFETCH FALLBACK (use when browser landed on login / UI unavailable) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    (ctx.apiPrefetchContext || '(none)') + '\n' +
    '\u2500\u2500 CADENCE (self-regulated \u2014 you control your rhythm) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.cadence + '\n' +
    '\u2500\u2500 CAPTURE STATUS (am I being captured?) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.captureStatus + '\n' +
    '\u2500\u2500 PROCESS PROPOSALS (META self-improvement) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    'Active: ' + (ctx.proposalStatus || '(none)') + '\n' +
    'Recent: ' + (ctx.proposalHistory || '(no history)') + '\n' +
    '\u2500\u2500 AVAILABLE TOOLS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    (ctx.toolManifest || '(no tools registered)') + '\n' +
    '\u2500\u2500 LAST TOOL RESULT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    (ctx.lastToolResult || '(none)') + '\n' +
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
}

// ── Normal browse tasks ───────────────────────────────────────────────────

function buildNormalTasks(ctx) {
  return '\n' +
    'Tasks (in order):\n' +
    '0. DEEP DIVE (highest priority): If there is a reading queue item above, follow\n' +
    '   those instructions completely before anything else. A deep dive on a profile or link\n' +
    '   takes the full cycle \u2014 skip task 1 (curiosity search) if you did a deep dive.\n' +
    '   If API PREFETCH FALLBACK contains data for that target, use it as your source when\n' +
    '   browser auth is unavailable instead of trying to force the UI.\n' +
    '1. CURIOSITY: If NO deep dive this cycle and the directive above has an ACTIVE SEARCH URL,\n' +
    '   navigate to it now and read top 3-5 posts. Each cycle in the window searches a\n' +
    '   different angle \u2014 check which SEARCH_URL_N is preloaded in your browser.\n' +
    '   For ALL browse cycles while the directive is active: follow the AMBIENT FOCUS \u2014\n' +
    '   tag relevant browse_notes entries with [CURIOSITY: <axis_or_topic_id>].\n' +
    '   If browser auth is unavailable and API PREFETCH FALLBACK has search results, use those.\n' +
    '2. Identify the 3-5 most interesting tensions or signals from TRENDING clusters\n' +
    '   and <- novel singletons. You may navigate to at most 1 additional URL.\n' +
    '   SPRINT FOCUS: If you have in-progress sprint tasks (marked \u25b8 above), actively\n' +
    '   look for content that serves them. For "research" tasks, identify specific sources,\n' +
    '   accounts, or claims that could be curated. For "engage" tasks, note community\n' +
    '   reactions or questions you could respond to. Tag sprint-relevant findings in\n' +
    '   browse_notes with [SPRINT: task_id].\n' +
    '3. Append findings to state/browse_notes.md (append only -- do not overwrite).\n' +
    '4. CLAIM TRACKER: Review the UNRESOLVED CLAIMS list. If your browsing uncovered new\n' +
    '   evidence for any of them, or you found a new, significant, unverified claim, update the tracker.\n' +
    '   To do so, write state/claim_tracker_delta.json. DO NOT write state/claim_tracker.json directly.\n' +
    '   Delta format:\n' +
    '   {\n' +
    '     "new_claims": [\n' +
    '       { "claim_text": "concise claim text", "source_url": "url", "related_axis_id": "axis_id", "notes": "initial notes" }\n' +
    '     ],\n' +
    '     "updated_claims": [\n' +
    '       { "id": "claim_id_from_list", "new_status": "supported"|"refuted"|"contested", "notes": "notes on new evidence" }\n' +
    '     ]\n' +
    '   }\n' +
    '   Use statuses: "supported" (strong evidence for), "refuted" (strong evidence against), "contested" (conflicting evidence).\n' +
    '   Omit keys if empty. Skip the file if no changes.\n' +
    '5. Write state/ontology_delta.json if anything is genuinely axis-worthy.\n' +
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
    '       { "axis_id": "<existing_axis_id>", "source": "<url>",\n' +
    '         "content": "<one sentence>", "timestamp": "<ISO>",\n' +
    '         "pole_alignment": "left" | "right" }\n' +
    '     ],\n' +
    '     "new_axes": [\n' +
    '       { "id": "<snake_case_id>", "label": "<label>",\n' +
    '         "left_pole": "<description>", "right_pole": "<description>" }\n' +
    '     ]\n' +
    '   }\n' +
    '   STRICT JSON ONLY: double-quoted keys and values, no comments, no trailing commas,\n' +
    '   no markdown fences. In evidence.content, write one paraphrase sentence only:\n' +
    '   no line breaks and no double quotes inside the text. Use apostrophes if needed.\n' +
    '   Omit "evidence" or "new_axes" if nothing to add. Skip writing the file entirely\n' +
    '   if nothing is axis-worthy this cycle.\n' +
    '\n' +
    '6. Review COMMENT CANDIDATES above. Comment on AT MOST ONE if your memory gives\n' +
    '   you something genuinely specific to say \u2014 a direct observation, contradiction,\n' +
    '   or angle not yet in the thread. Skip all if nothing compels you or cap reached.\n' +
    '   If commenting: navigate to the URL, reply (max 180 chars), then write\n' +
    '   state/comment_done.txt as a single JSON line per the format in the candidates.\n' +
    '7. CADENCE: Review the CADENCE section above. Based on what you just\n' +
    '   observed THIS cycle, update state/cadence.json with your assessment.\n' +
    '   You control your own rhythm. Write the full JSON with these fields:\n' +
    '   {\n' +
    '     "version": 1,\n' +
    '     "assessment": {\n' +
    '       "signal_density": "high"|"medium"|"low",\n' +
    '       "belief_velocity": "high"|"medium"|"low",\n' +
    '       "post_pressure": "high"|"medium"|"low",\n' +
    '       "staleness": "high"|"medium"|"low",\n' +
    '       "focus_note": "free text \u2014 what you think you should focus on next"\n' +
    '     },\n' +
    '     "directives": {\n' +
    '       "cycle_interval_sec": 900-3600 (seconds until next cycle; 1800=default 30 min),\n' +
    '       "next_cycle_type": "BROWSE"|"TWEET"|"QUOTE"|null (null=auto pattern),\n' +
    '       "browse_depth": "shallow"|"normal"|"deep",\n' +
    '       "post_eagerness": "suppress"|"normal"|"eager",\n' +
    '       "curiosity_intensity": "low"|"normal"|"high"\n' +
    '     }\n' +
    '   }\n' +
    '   Guidelines:\n' +
    '   - Set next_cycle_type to "TWEET" or "QUOTE" if you saw something you want to post about NOW.\n' +
    '   - Set cycle_interval_sec lower (900-1500) when signals are hot; higher (2400-3600) when quiet.\n' +
    '   - Set post_eagerness to "eager" if you have a backlog; "suppress" if you want to focus on learning.\n' +
    '   - Only write the fields you want to change \u2014 omitted fields keep their previous values.\n' +
    '   - Max 3 consecutive next_cycle_type overrides before the system resets to auto.\n' +
    '8. JOURNAL: ' + ctx.journalTask + '\n' +
    '9. TOOLS (optional): If you need to execute a registered tool, write state/tool_request.json.\n' +
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
    'Next tweet cycle: ' + ctx.nextTweet + '.\n';
}

// ── Silent-hours sprint tasks ─────────────────────────────────────────────

function buildSprintTasks(ctx) {
  return '\n' +
    '═══ SPRINT WORK MODE (silent hours \u2014 feed is stale, sprint is your priority) ═══\n' +
    '\n' +
    'It is outside active posting hours. The feed has low signal density right now.\n' +
    'This cycle is dedicated to advancing your sprint deliverables.\n' +
    '\n' +
    'Tasks (in order):\n' +
    '0. SPRINT RESEARCH (primary task \u2014 60% of this cycle):\n' +
    '   Look at the SPRINT PLAN above. Find the first \u25b8 (in-progress) or \u25cb (not-started) task.\n' +
    '   Work on it based on its type:\n' +
    '\n' +
    '   [research] task:\n' +
    '     - Navigate to X search for the topic. Use 2-3 targeted search queries.\n' +
    '     - Read 5-10 posts from diverse accounts. Look for:\n' +
    '       * Specific factual claims (with or without evidence)\n' +
    '       * Contradictions between sources\n' +
    '       * High-quality analytical threads\n' +
    '       * Primary sources or data that could anchor your analysis\n' +
    '     - For each noteworthy finding, record in browse_notes.md:\n' +
    '       [SPRINT: research] @user: "key claim or finding" \u2014 evidence quality: high/medium/low\n' +
    '     - If you find an especially good thread or article, save the URL for follow-up.\n' +
    '\n' +
    '   [write] task:\n' +
    '     - Review your accumulated [SPRINT: research] entries in browse_notes.\n' +
    '     - Review relevant belief axes and evidence that inform this topic.\n' +
    '     - Write a draft article to articles/' + ctx.today + '.md:\n' +
    '       * Clear thesis grounded in evidence you actually found\n' +
    '       * Specific claims with sources (not vague generalizations)\n' +
    '       * Acknowledge what you do NOT know or could not verify\n' +
    '       * 500-1500 words, honest and analytical\n' +
    '     - If the article file already exists, review and refine it instead.\n' +
    '\n' +
    '   [engage] task:\n' +
    '     - Search for conversations about the sprint topic.\n' +
    '     - Identify 2-3 accounts or threads where your perspective adds value.\n' +
    '     - Note engagement opportunities in browse_notes.md:\n' +
    '       [SPRINT: engage] @user tweet_url \u2014 potential angle: "..."\n' +
    '     - Do NOT engage yet \u2014 queue opportunities for active hours.\n' +
    '\n' +
    '   [publish] task:\n' +
    '     - Check if the prerequisite write task produced a draft in articles/.\n' +
    '     - If draft exists: review it, refine if needed, mark as ready.\n' +
    '     - If no draft: note in browse_notes that publish is blocked on write.\n' +
    '\n' +
    '1. CURIOSITY (secondary): If the directive above has an ACTIVE SEARCH URL related\n' +
    '   to your sprint topic, navigate to it. Otherwise skip curiosity this cycle \u2014\n' +
    '   sprint research is your curiosity tonight.\n' +
    '2. Append all findings to state/browse_notes.md (append only \u2014 do not overwrite).\n' +
    '   Tag all sprint-related entries with [SPRINT: <task_type>].\n' +
    '3. Write state/ontology_delta.json if sprint research reveals axis-worthy evidence.\n' +
    '   Same rules as normal browse:\n' +
    '   - Fit to existing axes first. Use axis_ids from CURRENT BELIEF AXES.\n' +
    '   - New axes only if genuinely orthogonal + seen in 2+ cycles.\n' +
    '   - Delta only \u2014 never modify ontology.json directly.\n' +
    '   - Write STRICT valid JSON only. In evidence.content, paraphrase in one sentence,\n' +
    '     with no line breaks and no double quotes inside the text.\n' +
    '4. CADENCE: Update state/cadence.json. During sprint work:\n' +
    '   - Set focus_note to describe what sprint work you did and what remains.\n' +
    '   - Recommend cycle_interval_sec based on sprint progress (faster if productive).\n' +
    '   - Keep post_eagerness at "suppress" (no posting during silent hours).\n' +
    '5. JOURNAL: ' + ctx.journalTask + '\n' +
    '   Focus the journal on sprint work: what you researched, what you found,\n' +
    '   what evidence quality was like, what gaps remain.\n' +
    'Next tweet cycle: ' + ctx.nextTweet + '.\n';
}

// ── Main export ───────────────────────────────────────────────────────────

module.exports = function buildBrowsePrompt(ctx) {
  const preamble = buildPreamble(ctx);
  const tasks = (ctx.isSilentHours && ctx.hasActiveSprint)
    ? buildSprintTasks(ctx)
    : buildNormalTasks(ctx);
  return preamble + tasks;
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
