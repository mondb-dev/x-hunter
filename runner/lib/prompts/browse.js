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
    (ctx.prefetchSource && (ctx.prefetchSource.startsWith('x_search_degraded') || !ctx.prefetchSource.startsWith('x')) ? (
      '\u2500\u2500 BROWSE SOURCE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
      ctx.prefetchSource.split('\n').slice(0,2).map((l,i) => i===0 ? 'Source: '+l : 'URL: '+l).join('\n') + '\n' +
      (ctx.prefetchSource.startsWith('x_search_degraded') ?
        'X search is broken this cycle (account suspended — read-only mode).\n' +
        'The X home feed still works — browser is on x.com/home. You CAN browse the feed.\n' +
        'But X search URLs will fail ("Something went wrong"). Do NOT navigate to x.com/search.\n' +
        'For curiosity research and claim verification, use web_search instead of X search.\n' +
        'Run 2-3 targeted web_search queries per cycle to compensate for lost X search.\n' +
        'The feed digest above still contains fresh X content from the scraper.\n'
      : ctx.prefetchSource.startsWith('reddit') ?
        'X unavailable this cycle. Browser is on Reddit.\n' +
        'This means the prefetch fallback worked. Do NOT say Reddit was blocked unless a tool call failed this cycle.\n' +
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
      : ctx.prefetchSource.startsWith('reuters') ?
        'X unavailable — browser is on Reuters.\n' +
        'Read top stories for factual, wire-service-grade reporting. Cross-reference claims\n' +
        'from your feed digest. Tag browse_notes entries with [REUTERS].\n'
      : ctx.prefetchSource.startsWith('none') ?
        'Browser prefetch unavailable this cycle. X session may have expired.\n' +
        'Only describe X or browser access as blocked if this exact condition happened this cycle.\n' +
        'Rely on the feed digest above and use web_search for fresh information.\n'
      : 'X unavailable — browser is on an external source. Apply same observation principles.\n') +
      '\n'
    ) : '') +
    '\u2500\u2500 UNRESOLVED CLAIMS (open from claim tracker) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.unresolvedClaims + '\n' +
    '\u2500\u2500 INTELLIGENCE TENSIONS (iran-us-israel conflict tracker) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    ctx.intelTensions + '\n' +
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
    '   The link may be an intentional off-platform source selected from your strongest\n' +
    '   convictions. Treat that as normal browse work, not as a fallback mode.\n' +
    '   browser auth is unavailable instead of trying to force the UI.\n' +
    '1. CURIOSITY: If NO deep dive this cycle:\n' +
    '   WEB SEARCH FIRST: Run web_search with 2-3 targeted queries on the curiosity directive\n' +
    '   topic before doing anything else. This is always your first curiosity action \u2014\n' +
    '   web_search works regardless of X login state, returns real-time indexed web content,\n' +
    '   and surfaces primary sources, academic papers, and coverage that X discourse never\n' +
    '   contains. Good query forms: "<topic> primary source", "<claim> evidence 2025",\n' +
    '   "<actor> <event> site:reuters.com OR site:ft.com". Extract verifiable facts, source\n' +
    '   URLs, named actors, and specific dates \u2014 these become high-quality ontology evidence\n' +
    '   with real citations that survive audit.\n' +
    '   X SEARCH SUPPLEMENT: After web_search, if the directive has an ACTIVE SEARCH URL,\n' +
    '   navigate to it to read social reaction (top 3-5 posts). X shows what people believe;\n' +
    '   web_search shows what is documented. Both matter \u2014 web_search always runs first.\n' +
    '   Tag all findings [CURIOSITY: <id>].\n' +
    '   For ALL browse cycles while the directive is active: follow the AMBIENT FOCUS \u2014\n' +
    '   tag relevant browse_notes entries with [CURIOSITY: <axis_or_topic_id>].\n' +
    '2. Identify the 3-5 most interesting tensions or signals from TRENDING clusters\n' +
    '   and <- novel singletons. You may navigate to at most ' + ctx.maxNavUrls + ' additional URL' + (ctx.maxNavUrls === 1 ? '' : 's') + '.\n' +
    (ctx.maxNavUrls === 0 ? '   (shallow depth this cycle \u2014 rely on digest + web_search, skip additional URL navigation)\n' : '') +
    '   WEB SEARCH: For the single most significant TRENDING story, run web_search to find\n' +
    '   the primary source, original data, or authoritative external coverage. This grounds\n' +
    '   your ontology updates in verifiable fact rather than X\'s second-hand discourse.\n' +
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
    '4. CLAIM TRACKER: Review the UNRESOLVED CLAIMS list. If your browsing uncovered new\n' +
    '   evidence for any of them, or you found a new, significant, unverified claim, update the tracker.\n' +
    '   WEB SEARCH: Before marking a claim "supported" or "refuted", run web_search to find\n' +
    '   independent verification. Do not resolve a claim based solely on X posts.\n' +
    '   To do so, write state/claim_tracker_delta.json. DO NOT write state/claim_tracker.json directly.\n' +
    '   Delta format:\n' +
    '   {\n' +
    '     "new_claims": [\n' +
    '       { "claim_text": "concise claim text", "source_post_url": "x status url or source post url", "cited_url": "external article/doc url if present", "related_axis_id": "axis_id", "notes": "initial notes" }\n' +
    '     ],\n' +
    '     "updated_claims": [\n' +
    '       { "id": "claim_id_from_list", "new_status": "supported"|"refuted"|"contested", "source_post_url": "optional updated source post", "cited_url": "optional external article/doc url", "notes": "notes on new evidence" }\n' +
    '     ]\n' +
    '   }\n' +
    '   If you only have one URL, use source_post_url for the X post and let the system infer cited_url when possible.\n' +
    '   Use statuses: "supported" (strong evidence for), "refuted" (strong evidence against), "contested" (conflicting evidence).\n' +
    '   Omit keys if empty. Skip the file if no changes.\n' +
    '4b. INTELLIGENCE TENSIONS: Review the INTELLIGENCE TENSIONS section above. These are\n' +
    '   tracked conflict claims for the iran-us-israel situation. Use this section to:\n' +
    '   - Prioritize browsing on topics where contradictions are actively building (↔ pairs).\n' +
    '   - If you encounter new evidence corroborating or refuting a listed claim, note its\n' +
    '     claim text in browse_notes.md with [INTEL: <category>] and add it to the claim\n' +
    '     tracker delta (task 4) as a new_claim or updated_claim if you can match by text.\n' +
    '   - No write action required — this is read-only signal for browsing focus.\n' +
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
    '   SELF-ECHO RULE: if a post is quoting, paraphrasing, or recycling your own prior\n' +
    '   tweets, replies, articles, or journals, treat it as resonance or feedback only.\n' +
    '   It is NOT independent evidence and must not reinforce an axis.\n' +
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
    '   VERIFICATION RULE: Do not describe any claim as "unverified" or "unconfirmed"\n' +
    '   unless you have already attempted web_search on it this cycle and found no\n' +
    '   corroboration. If you have not searched: either search now, or state what you\n' +
    '   observed on X without a verification label. "Unverified" is a conclusion, not\n' +
    '   a default — it requires a real search attempt first.\n' +
    '   ACCESS GROUNDING RULE: Do not write that X, Reddit, or web_search were blocked\n' +
    '   unless that failure happened THIS cycle and is evidenced by BROWSE SOURCE above,\n' +
    '   LAST TOOL RESULT, or an explicit tool error you just encountered.\n' +
    '   Do not chain together past failures from memory. If X redirected to login but\n' +
    '   Reddit loaded, say exactly that. If web_search was not attempted this cycle,\n' +
    '   do not mention web_search failure at all.\n' +
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
    '     PRIMARY: Use web_search with 3-5 targeted queries about the PLAN TOPIC (the subject\n' +
    '       matter of the sprint plan \u2014 e.g. key terms from the plan description or belief axes).\n' +
    '       Do NOT search for the task title itself as a search query.\n' +
    '       web_search works regardless of browser auth \u2014 always try it first.\n' +
    '     SECONDARY: If BROWSE SOURCE above shows X is available, also navigate to X search\n' +
    '       for 2-3 additional queries. If X shows a login page, skip browser navigation\n' +
    '       entirely \u2014 web_search is your full research tool this cycle.\n' +
    '     - Extract findings from 5-10 diverse sources. Look for:\n' +
    '       * Specific factual claims (with or without evidence)\n' +
    '       * Contradictions between sources\n' +
    '       * High-quality analytical threads\n' +
    '       * Primary sources or data that could anchor your analysis\n' +
    '     - For each noteworthy finding, record in browse_notes.md:\n' +
    '       [SPRINT: research] source: "key claim or finding" \u2014 evidence quality: high/medium/low\n' +
    '     - A task is only BLOCKED if both web_search AND X returned nothing relevant.\n' +
    '       If web_search produced results, the task is IN PROGRESS, not blocked.\n' +
    '     - If you find an especially good article, save the URL for follow-up.\n' +
    '\n' +
    '   [write] task:\n' +
    '     - Review your accumulated [SPRINT: research] entries in browse_notes.\n' +
    '     - Review relevant belief axes and evidence that inform this topic.\n' +
    '     - Write a draft article to articles/' + ctx.today + '.md:\n' +
    '       * Write as Sebastian D. Hunter \u2014 your vocation (WHO YOU ARE above) is the voice.\n' +
    '         A digital watchdog for public integrity: analytical, direct, grounded in data.\n' +
    '         The article should only be publishable under your name \u2014 not generic commentary.\n' +
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
    '   [reflect] task — internal synthesis only. Do NOT browse X, Reddit, or any external URL.\n' +
    '     The word "feedback" in the task title means feedback already captured in your local\n' +
    '     files (browse_notes, journals). There is nothing to fetch externally.\n' +
    '     This task is NEVER blocked by X login or Reddit blocks \u2014 all data is local.\n' +
    '     - Use read_file to read state/browse_notes.md in full.\n' +
    '     - Use list_files on journals/ then read_file on the 5 most recent journal files.\n' +
    '     - Collect all entries tagged [SPRINT: research], [SPRINT: engage], or similar.\n' +
    '     - Identify key themes, contradictions, gaps, and strongest findings.\n' +
    '     - Write a structured collation to state/sprint_reflect.md:\n' +
    '       * Section: Key Findings (bullet list with source references)\n' +
    '       * Section: Themes and Patterns\n' +
    '       * Section: Gaps and Unknowns\n' +
    '       * Section: Recommended Next Steps\n' +
    '     - If browse_notes mention this task was "blocked" in prior cycles, ignore that \u2014\n' +
    '       those entries were wrong. The task requires only local reads.\n' +
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
    '   Write a standard observation journal (150-200 words, same format as normal cycles).\n' +
    '   If sprint research yielded concrete findings, include a brief note.\n' +
    '   If X searches for the sprint topic were unproductive or returned no results, draw\n' +
    '   observations from the FEED DIGEST above instead.\n' +
    '   Do NOT write a journal entry that is solely about failed searches or blocked sprint work.\n' +
    '   Do NOT claim that Reddit, X, and web_search all failed unless all three failures\n' +
    '   actually happened THIS cycle. Use only current-cycle evidence from BROWSE SOURCE,\n' +
    '   LAST TOOL RESULT, or explicit tool errors. Never import failure chains from prior cycles.\n' +
    '6. HUMAN REQUEST: If a sprint task is genuinely blocked because it requires something\n' +
    '   only the operator can provide (a website, community platform, account, service),\n' +
    '   write state/human_request.json \u2014 the operator will receive a Telegram message.\n' +
    '   Only use this for real blockers, not X login failures or tool errors.\n' +
    '   Format: { "message": "what you need and why", "action_needed": "website"|"community"|"account"|"other",\n' +
    '             "priority": "low"|"medium"|"high", "sprint_task": "task name" }\n' +
    '   Cooldown: once per 4 hours per action type.\n' +
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
