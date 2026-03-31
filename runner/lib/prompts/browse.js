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
    '\u2500\u2500 UNRESOLVED CLAIMS (claims to verify or refute) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.unresolvedClaims + '\n' +
    '\u2500\u2500 SPRINT PLAN (ACTIVE \u2014 guide your browsing toward these tasks) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.sprintContext + '\n' +
    '\u2500\u2500 RECENT DISCOURSE (reply exchanges) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.discourseDigest + '\n' +
    '\u2500\u2500 READING QUEUE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.readingBlock + '\n' +
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
    '1. CURIOSITY: If NO deep dive this cycle and the directive above has an ACTIVE SEARCH URL,\n' +
    '   navigate to it now and read top 3-5 posts. Each cycle in the window searches a\n' +
    '   different angle \u2014 check which SEARCH_URL_N is preloaded in your browser.\n' +
    '   For ALL browse cycles while the directive is active: follow the AMBIENT FOCUS \u2014\n' +
    '   tag relevant browse_notes entries with [CURIOSITY: <axis_or_topic_id>].\n' +
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
    '   - Set next_cycle_type to "TWEET" or "QUOTE" only if you have a high-conviction idea.\n' +
    '   - Increase cycle_interval_sec if signal is low. Decrease if high.\n' +
    '   - Use focus_note to guide your future self.\n' +
    '   - You can override the default cycle pattern up to 3 times in a row.\n' +
    '\n' +
    '8. JOURNAL: ' + ctx.journalTask + '\n';
}

// ── Silent-hours sprint tasks ─���───────────────────────────────────────────

function buildSprintTasks(ctx) {
  return '\n' +
    'Tasks (in order):\n' +
    '1. SPRINT WORK (PRIMARY): The feed is quiet. Focus on your active sprint.\n' +
    '   Review the SPRINT PLAN above. Your primary goal this cycle is to make progress\n' +
    '   on the tasks marked with \u25b8 (in-progress).\n' +
    '   - For "research" tasks, use the search tool to find relevant accounts, papers,\n' +
    '     or discussions. Curate findings into state/sprint_research_notes.md.\n' +
    '   - For "drafting" tasks, write or refine content in the specified file.\n' +
    '   - For "engagement" tasks, browse relevant communities or hashtags, take notes on\n' +
    '     the discourse, and identify opportunities to contribute.\n' +
    '   - Update the sprint plan by writing a new state/sprint_context.json, moving tasks\n' +
    '     from \u25b7 to \u25b6 (done) or updating notes.\n' +
    '2. BROWSE (SECONDARY): Briefly scan the feed digest for anything truly novel or\n' +
    '   surprising that might be relevant to your sprint. Append brief notes to\n' +
    '   state/browse_notes.md, tagging with [SPRINT: task_id].\n' +
    '3. JOURNAL: ' + ctx.journalTask + '\n';
}

// ── Main entrypoint ───────────────────────────────────────────────────────

function buildBrowsePrompt(ctx) {
  const preamble = buildPreamble(ctx);
  const tasks = (ctx.isSilentHours && ctx.hasActiveSprint)
    ? buildSprintTasks(ctx)
    : buildNormalTasks(ctx);
  return preamble + tasks;
}

module.exports = { buildBrowsePrompt };
