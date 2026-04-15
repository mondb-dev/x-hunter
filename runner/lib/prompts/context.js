'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { buildToolManifest, loadLastToolResult } = require('../tools');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read a state file with optional tail-N-lines and backtick sanitisation.
 * Backticks → apostrophes for prompt safety (matches bash sed behaviour).
 */
function readState(filePath, opts = {}) {
  const { tail, fallback = '' } = opts;
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (tail) {
      const lines = content.split('\n');
      content = lines.slice(-tail).join('\n');
    }
    return content.replace(/`/g, "'") || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Format ontology axes — compact form for browse + tweet prompts.
 *   [axis_id] label (conf:XX%, ev:N)
 *     L: left_pole (truncated 80 chars)
 *     R: right_pole (truncated 80 chars)
 */
function formatCurrentAxes() {
  try {
    const d = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf-8'));
    const axes = d.axes || [];
    if (axes.length === 0) return '  (none yet)';
    return axes.map(a => {
      const ev = (a.evidence_log || []).length;
      const conf = ((a.confidence || 0) * 100).toFixed(0);
      return '  [' + a.id + '] ' + a.label + ' (conf:' + conf + '%, ev:' + ev + ')\n' +
             '    L: ' + a.left_pole.slice(0, 80) + '\n' +
             '    R: ' + a.right_pole.slice(0, 80);
    }).join('\n');
  } catch (e) {
    return '  (could not read ontology.json: ' + e.message + ')';
  }
}

/**
 * Format top belief axes with evidence — for quote prompt.
 * Filters confidence >= 0.65, sorts desc, takes top 6.
 */
function formatTopAxes() {
  try {
    const o = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf-8'));
    const raw = Array.isArray(o.axes) ? o.axes : Object.values(o.axes || {});
    const axes = raw
      .filter(a => a.confidence >= 0.65)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);
    if (axes.length === 0) return '(unavailable)';
    return axes.map(a => {
      const ev = (a.evidence_log || []).slice(-2)
        .map(e => '    * ' + e.content.slice(0, 120)).join('\n');
      return '- ' + a.label + ' (conf: ' + (a.confidence * 100).toFixed(0) + '%)\n' +
             '  LEFT: ' + a.left_pole + '\n' +
             '  RIGHT: ' + a.right_pole +
             (ev ? '\n  Recent evidence:\n' + ev : '');
    }).join('\n\n');
  } catch {
    return '(unavailable)';
  }
}

/**
 * Build compact list of already-quoted source URLs (quote prompt dedup).
 */
function formatQuotedSources() {
  try {
    const posts = JSON.parse(fs.readFileSync(config.POSTS_LOG_PATH, 'utf-8')).posts || [];
    const quotes = posts.filter(p => p.type === 'quote' && p.source_url);
    if (quotes.length === 0) return '(none yet)';
    return quotes.map(q => '- ' + q.source_url).join('\n');
  } catch {
    return '(none yet)';
  }
}

/**
 * Format capture detection status — compact summary for browse/tweet prompts.
 * Reads state/capture_state.json written by capture_detection.js.
 */
function formatCaptureStatus() {
  try {
    const fp = path.join(config.STATE_DIR, 'capture_state.json');
    const c = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!c || !c.status) return '(capture detection not yet run)';
    if (c.status === 'clean') return c.summary || 'Clean — no capture alerts.';
    // warning or captured — show alerts
    const lines = [`Status: ${c.status.toUpperCase()} (${c.evidence_24h} evidence entries, ${c.unique_sources} sources)`];
    for (const a of (c.alerts || [])) {
      lines.push(`  [${a.severity.toUpperCase()}] ${a.detail}`);
    }
    return lines.join('\n');
  } catch {
    return '(capture detection not yet run)';
  }
}

/**
 * Format cadence state for browse prompt.
 * Shows Sebastian's current self-regulated assessment, directives, and recent history.
 */
function formatCadence() {
  try {
    const m = JSON.parse(fs.readFileSync(
      path.join(config.STATE_DIR, 'cadence.json'), 'utf-8'));
    const a = m.assessment || {};
    const d = m.directives || {};
    const lines = [
      'Current assessment:',
      '  Signal density: ' + (a.signal_density || '?'),
      '  Belief velocity: ' + (a.belief_velocity || '?'),
      '  Post pressure: ' + (a.post_pressure || '?'),
      '  Staleness: ' + (a.staleness || '?'),
    ];
    if (a.focus_note) lines.push('  Focus note: ' + a.focus_note);
    lines.push('Current directives:');
    lines.push('  Cycle interval: ' + (d.cycle_interval_sec || 1800) + 's');
    lines.push('  Next cycle type: ' + (d.next_cycle_type || 'auto'));
    lines.push('  Browse depth: ' + (d.browse_depth || 'normal'));
    lines.push('  Post eagerness: ' + (d.post_eagerness || 'normal'));
    lines.push('  Curiosity intensity: ' + (d.curiosity_intensity || 'normal'));
    lines.push('  Consecutive overrides: ' + (m.consecutive_overrides || 0) + '/3');
    if (m.last_assessed) lines.push('  Last assessed: ' + m.last_assessed);
    return lines.join('\n');
  } catch {
    return '(cadence not yet initialized)';
  }
}

/**
 * Load current proposal status — compact summary for browse prompt.
 */
function loadProposalStatus() {
  try {
    const p = JSON.parse(fs.readFileSync(
      path.join(config.STATE_DIR, 'process_proposal.json'), 'utf-8'));
    return `Proposal "${p.title}" — status: ${p.status} (${p.scope}, risk: ${p.estimated_risk})`;
  } catch {
    return '(no active proposal)';
  }
}

/**
 * Load proposal history — compact summary of past proposals and outcomes.
 */
function loadProposalHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(
      path.join(config.STATE_DIR, 'proposal_history.json'), 'utf-8'));
    const proposals = h.proposals || [];
    if (proposals.length === 0) return '(no proposals yet)';
    return proposals.slice(-5).map(p =>
      `- [${p.status}] "${p.title}" (${p.resolved_at?.slice(0, 10) || '?'})` +
      (p.resolution_notes ? ` — ${p.resolution_notes.slice(0, 80)}` : '') +
      (p.reverted ? ' [REVERTED]' : '')
    ).join('\n');
  } catch {
    return '(no proposal history)';
  }
}

/**
 * Load sprint context with active_plan.json fallback (tweet prompt).
 */
function loadActivePlanContext() {
  // Primary: sprint_context.txt (written by sprint_manager.js)
  try {
    const content = fs.readFileSync(config.SPRINT_CONTEXT_PATH, 'utf-8');
    if (content.trim()) return content.replace(/`/g, "'");
  } catch {}

  // Fallback: active_plan.json
  try {
    const a = JSON.parse(fs.readFileSync(config.ACTIVE_PLAN_PATH, 'utf-8'));
    if (a && a.status === 'active') {
      const days = Math.floor((Date.now() - new Date(a.activated_date).getTime()) / 86400000);
      return 'ACTIVE PLAN: ' + a.title + '\n' +
             'Goal: ' + (a.first_sprint?.week_1_goal || '(none)') + '\n' +
             'Day ' + days + ' of 30';
    }
  } catch {}

  return '(no active plan)';
}

/**
 * Parse reading_url.txt → reading block for browse prompt.
 * Detects X profile deep dive vs article/content link.
 */
function buildReadingBlock() {
  const NONE = '(no reading queue item this cycle)';
  let url = '', from = '', context = '';
  try {
    const raw = fs.readFileSync(config.READING_URL_PATH, 'utf-8');
    if (!raw.trim()) return NONE;
    const m1 = raw.match(/^URL:\s*(.+)/m);
    const m2 = raw.match(/^FROM:\s*(.+)/m);
    const m3 = raw.match(/^CONTEXT:\s*(.+)/m);
    url     = (m1 ? m1[1].trim() : '').replace(/`/g, "'");
    from    = (m2 ? m2[1].trim() : '').replace(/`/g, "'");
    context = (m3 ? m3[1].trim() : '').replace(/`/g, "'");
  } catch { return NONE; }
  if (!url) return NONE;

  if (from === 'conviction_source') {
    return 'Regular source collection selected an off-platform source for this cycle.\n' +
      '  URL: ' + url + '\n' +
      '  Context: ' + context + '\n\n' +
      '  Treat this as a first-class browse task, not a fallback.\n' +
      '  Read for concrete facts, named sources, missing evidence, and points that could\n' +
      '  either sharpen or challenge the relevant belief axis.\n' +
      "  Write findings in browse_notes.md under '## Conviction Source: " + url + "'";
  }

  // Profile deep dive
  if (/^https:\/\/x\.com\/[A-Za-z0-9_]+\/?$/.test(url)) {
    const h = url.replace('https://x.com/', '').replace(/\/$/, '');
    return from + ' asked you to learn about @' + h +
      '. DEEP DIVE \u2014 this is your primary task this cycle:\n' +
      '  URL: ' + url + '\n' +
      '  Context: ' + context + '\n\n' +
      '  Do all of the following:\n' +
      '  1. Navigate to their profile. Read their pinned tweet and bio.\n' +
      '  2. Scroll their timeline \u2014 read at least 8 recent tweets. Note their main positions,\n' +
      '     recurring themes, and any tensions or contradictions.\n' +
      '  3. Check if their views connect to any of your current belief axes. Note evidence.\n' +
      "  4. Search for '@" + h + "' to see how others engage with them (optional if time allows).\n" +
      "  5. Write a dedicated section in browse_notes.md: '## Deep Dive: @" + h + "'\n" +
      '     Summarise what you learned and whether it shifted any of your beliefs.';
  }

  // Article / content URL
  return from + ' recommended a link. Navigate to it as your FIRST task:\n' +
    '  ' + url + '\n' +
    '  Context: ' + context + '\n' +
    '  Read it carefully. Note key claims, evidence quality, and any tensions with your current axes.\n' +
    "  Write findings in browse_notes.md under '## Reading: " + url + "'";
}

/**
 * Build journal task string (browse or tweet cycle).
 */
function buildJournalTask(type, today, hour, dayNumber) {
  const jPath = path.join(config.JOURNALS_DIR, today + '_' + hour + '.html');
  if (fs.existsSync(jPath)) {
    if (type === 'browse') {
      return 'journals/' + today + '_' + hour +
        '.html ALREADY EXISTS. DO NOT write or overwrite this file under any circumstances \u2014 it has been permanently archived to Arweave and cannot be changed.';
    }
    return 'journals/' + today + '_' + hour +
      '.html ALREADY EXISTS. DO NOT write or overwrite this file \u2014 it has been permanently archived to Arweave.';
  }
  if (type === 'browse') {
    return 'Write journals/' + today + '_' + hour + '.html now. This is Day ' + dayNumber + '.\n' +
      '   The journal has TWO required sections inside <article>:\n' +
      '\n' +
      '   SECTION 1 — synthesis (required): Your interpretive narrative for this cycle.\n' +
      '   Write as Sebastian D. Hunter: a digital watchdog for public integrity.\n' +
      '   Your vocation (WHO YOU ARE above) is the lens. What you choose to notice,\n' +
      '   what you find significant, and how you frame it should reflect that identity.\n' +
      '   One or two key tensions or signals you noticed. What is new or surprising.\n' +
      '   Where does what you observed connect to disinformation, accountability, power, or\n' +
      '   the integrity of public information? That is the thread. Pull on it.\n' +
      '   ~150-200 words. Use <section class="stream">, <section class="tensions">,\n' +
      '   <section class="images">, <section class="footnotes"> as usual.\n' +
      '\n' +
      '   SECTION 2 — raw observations (required): Read state/browse_notes.md RIGHT NOW\n' +
      '   and include ALL entries as-is inside a <section class="browse-notes"> block\n' +
      '   at the END of the article, just before </article>. Format:\n' +
      '     <section class="browse-notes">\n' +
      '       <h2>Raw Observations</h2>\n' +
      '       <ul>\n' +
      '         <li>[TAG] text of observation</li>\n' +
      '         ... one <li> per line from browse_notes.md ...\n' +
      '       </ul>\n' +
      '     </section>\n' +
      '   This section is mandatory. Do not skip it or summarise — copy the raw lines.\n' +
      '\n' +
      '   Use standard HTML journal format. In the HTML metadata use content="' + dayNumber + '"\n' +
      '   for x-hunter-day and "Day ' + dayNumber + ' \u00b7 Hour ' + hour + '" in the header.\n' +
      '   This is the public record of what you observed. Keep it honest and specific.';
  }
  // tweet
  return 'Write journals/' + today + '_' + hour + '.html (Day ' + dayNumber +
    '). Use x-hunter-day content="' + dayNumber + '" and "Day ' + dayNumber +
    ' \u00b7 Hour ' + hour + '" in the header.';
}

/**
 * Format vocation — Sebastian's current purpose, label, statement, and defining axes.
 * Returns a short block for injection into all prompt preambles.
 */
function formatVocation() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(config.STATE_DIR, 'vocation.json'), 'utf-8'));
    const label       = v.label       || '(forming)';
    const description = v.description || '';
    const statement   = v.statement   || '';
    const intent      = v.intent      || '';

    // Resolve core axis IDs to labels from the ontology
    let axisLabels = [];
    try {
      const o = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, 'utf-8'));
      const axisMap = {};
      (o.axes || []).forEach(a => { axisMap[a.id] = a.label; });
      axisLabels = (v.core_axes || []).map(id => axisMap[id] || id);
    } catch {}

    let out = 'Vocation: ' + label + ' [' + (v.status || 'forming') + ']\n';
    if (description) out += description + '\n';
    if (statement)   out += 'In my words: ' + statement + '\n';
    if (intent)      out += 'What I do: ' + intent + '\n';
    if (axisLabels.length) {
      out += 'Core belief axes that define this vocation:\n';
      axisLabels.forEach(l => { out += '  - ' + l + '\n'; });
      out += 'When deciding what to write about or how to frame an observation, these axes\n';
      out += 'are your primary filter. Prioritise signals that touch them.';
    }
    return out.trim();
  } catch {
    return '(vocation not yet formed)';
  }
}

function formatUnresolvedClaims() {
  try {
    const raw = fs.readFileSync(config.CLAIM_TRACKER_PATH, 'utf-8');
    const tracker = JSON.parse(raw);
    const open = (tracker.claims || []).filter(c => c.status === 'unverified' || c.status === 'contested');
    if (!open.length) return '(no open claims)';
    return open.slice(0, 10).map(c =>
      `[${c.id}] ${c.claim_text} — status: ${c.status}` +
      (c.related_axis_id ? ` | axis: ${c.related_axis_id}` : '') +
      (c.notes ? ` | notes: ${c.notes}` : '')
    ).join('\n');
  } catch { return '(no open claims)'; }
}

function formatIntelligenceTensions() {
  try {
    const p = path.join(config.STATE_DIR, 'intelligence_export.json');
    if (!fs.existsSync(p)) return '(no intelligence export)';
    const intel = JSON.parse(fs.readFileSync(p, 'utf-8'));

    const categories = intel.categories || {};
    const contradictions = intel.contradictions || [];

    // Claims from all categories, ranked by total evidence activity
    const allClaims = Object.values(categories)
      .flatMap(c => c.claims || [])
      .filter(c => (c.corroborating_count || 0) + (c.contradicting_count || 0) > 0)
      .sort((a, b) =>
        (b.corroborating_count + b.contradicting_count) -
        (a.corroborating_count + a.contradicting_count))
      .slice(0, 5);

    let out = `Conflict tracker (iran-us-israel): ${intel.claim_count || 0} claims across ${Object.keys(categories).length} categories\n`;

    if (contradictions.length) {
      out += `Active contradictions (${contradictions.length} total — top 3):\n`;
      for (const c of contradictions.slice(0, 3)) {
        const s0 = (c.sides && c.sides[0] && c.sides[0].claim_text || '').slice(0, 80);
        const s1 = (c.sides && c.sides[1] && c.sides[1].claim_text || '').slice(0, 80);
        out += `  [${c.category || '?'}] "${s0}" ↔ "${s1}"\n`;
      }
    }

    if (allClaims.length) {
      out += `Most corroborated claims:\n`;
      for (const c of allClaims) {
        const handle = c.source_handle ? `@${c.source_handle}: ` : '';
        out += `  +${c.corroborating_count || 0}/-${c.contradicting_count || 0} ${handle}${c.claim_text.slice(0, 100)}\n`;
      }
    }

    return out.trim();
  } catch {
    return '(intelligence export unavailable)';
  }
}

function formatEngagementSummary() {
  try {
    const p = config.ENGAGEMENT_SUMMARY_PATH;
    if (!fs.existsSync(p)) return '(engagement data not yet collected)';
    const eng = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const s = eng.stats || {};
    const age = eng.generated_at
      ? Math.round((Date.now() - new Date(eng.generated_at).getTime()) / 60_000)
      : null;
    const ageStr = age !== null ? ` (${age}m ago)` : '';
    const best = eng.best;
    const bestStr = best
      ? ` Best: "${best.text_preview.slice(0, 60)}" — ${best.likes}❤ ${best.replies}↩`
      : '';
    return [
      `Recent engagement${ageStr}: avg ${s.avg_likes ?? '?'}❤ ${s.avg_replies ?? '?'}↩ per post`,
      `Trend: ${s.trend ?? '?'} | Followers: ${eng.followers ?? '?'}`,
      bestStr,
    ].filter(Boolean).join('\n');
  } catch { return '(engagement data unavailable)'; }
}

// ── Main loader ─────────────────────────────────────────────────────────────

/**
 * Load all context needed for a given prompt type.
 *
 * @param {Object} opts
 * @param {string} opts.type   - 'browse' | 'tweet' | 'quote' | 'first_run'
 * @param {number} opts.cycle  - current cycle number
 * @param {number} opts.dayNumber
 * @param {string} opts.today  - YYYY-MM-DD
 * @param {string} opts.now    - HH:MM
 * @param {string} opts.hour   - HH (zero-padded)
 * @returns {Object} ctx
 */
function loadContext(opts) {
  const { type, cycle, dayNumber, today, now, hour } = opts;
  const ctx = { type, cycle, dayNumber, today, now, hour };

  if (type === 'first_run') return ctx;

  if (type === 'browse') {
    // Digest window and max nav URLs scale with cadence assessment signals.
    // signal_density drives how much of the digest the agent sees.
    // browse_depth (agent-set directive) controls URL navigation budget.
    let signalDensity = 'medium';
    let browseDepth   = 'normal';
    try {
      const cad = JSON.parse(fs.readFileSync(
        require('path').join(config.STATE_DIR, 'cadence.json'), 'utf-8'));
      signalDensity = cad?.assessment?.signal_density  || 'medium';
      browseDepth   = cad?.directives?.browse_depth    || 'normal';
    } catch {}
    const digestTailLines = signalDensity === 'high' ? 300 : signalDensity === 'low' ? 80 : 160;
    ctx.maxNavUrls  = browseDepth === 'shallow' ? 0 : browseDepth === 'deep' ? 3 : 1;
    ctx.browseDepth = browseDepth;

    ctx.trajectoryContext = readState(config.TRAJECTORY_SUMMARY_PATH, { fallback: '' });
    ctx.browseNotes       = readState(config.BROWSE_NOTES_PATH, { tail: 80, fallback: '(empty)' });
    ctx.topicSummary      = readState(config.TOPIC_SUMMARY_PATH, { fallback: '(not yet generated)' });
    ctx.digest            = readState(config.FEED_DIGEST_PATH, { tail: digestTailLines, fallback: '(not yet generated)' });
    ctx.critique          = readState(config.CRITIQUE_PATH, { tail: 12, fallback: '' });
    ctx.articleMeta       = readState(config.ARTICLE_META_PATH, { fallback: '' });
    ctx.curiosityDirective = readState(config.CURIOSITY_DIRECTIVE_PATH, { fallback: '' });
    ctx.commentCandidates = readState(config.COMMENT_CANDIDATES_PATH, { fallback: '' });
    ctx.discourseDigest   = readState(config.DISCOURSE_DIGEST_PATH, { fallback: '' });
    ctx.sprintContext     = readState(config.SPRINT_CONTEXT_PATH, { fallback: '(no active plan)' });
    ctx.readingBlock      = buildReadingBlock();
    ctx.prefetchSource    = readState(config.PREFETCH_SOURCE_PATH, { fallback: '' }).trim();
    ctx.unresolvedClaims  = formatUnresolvedClaims();
    ctx.intelTensions     = formatIntelligenceTensions();
    ctx.memoryRecall      = readState(config.MEMORY_RECALL_PATH, { fallback: '(empty)' });
    ctx.currentAxes       = formatCurrentAxes();
    ctx.cadence            = formatCadence();
    ctx.captureStatus     = formatCaptureStatus();
    ctx.vocation          = formatVocation();
    ctx.journalTask       = buildJournalTask('browse', today, hour, dayNumber);
    ctx.nextTweet         = (Math.floor(cycle / config.TWEET_EVERY) + 1) * config.TWEET_EVERY;

    // META cycle awareness: load proposal + history so Sebastian sees outcomes
    ctx.proposalStatus    = loadProposalStatus();
    ctx.proposalHistory   = loadProposalHistory();

    // Tool system
    ctx.toolManifest      = buildToolManifest();
    ctx.lastToolResult    = loadLastToolResult();

    // Silent-hours sprint detection (UTC 23-07: feed is stale, redirect to sprint work)
    const hourInt = parseInt(hour, 10);
    ctx.isSilentHours = hourInt < config.TWEET_START || hourInt >= config.TWEET_END;
    ctx.hasActiveSprint = ctx.sprintContext &&
      ctx.sprintContext.trim() !== '(no active plan)' &&
      ctx.sprintContext.trim() !== '(no active sprint)';
  }

  if (type === 'quote') {
    ctx.vocation          = formatVocation();
    ctx.sprintContext     = readState(config.SPRINT_CONTEXT_PATH, { fallback: '(no active plan)' });
    ctx.quotedSources     = formatQuotedSources();
    ctx.digest            = readState(config.FEED_DIGEST_PATH, { tail: 120, fallback: '(not available)' });
    ctx.topAxes           = formatTopAxes();
    ctx.memoryRecall      = readState(config.MEMORY_RECALL_PATH, { fallback: '(empty)' });
    ctx.postingDirective  = readState(config.POSTING_DIRECTIVE_PATH, { fallback: '' });
    ctx.lastToolResult    = loadLastToolResult();
  }

  if (type === 'tweet') {
    ctx.browseNotesFull   = readState(config.BROWSE_NOTES_PATH, { fallback: '(empty)' });
    ctx.memoryRecall      = readState(config.MEMORY_RECALL_PATH, { fallback: '(empty)' });
    ctx.discourseDigest   = readState(config.DISCOURSE_DIGEST_PATH, { fallback: '(no discourse yet)' });
    ctx.activePlanContext = loadActivePlanContext();
    ctx.currentAxes       = formatCurrentAxes();
    ctx.captureStatus     = formatCaptureStatus();
    ctx.postingDirective  = readState(config.POSTING_DIRECTIVE_PATH, { fallback: '' });
    ctx.vocation          = formatVocation();
    ctx.journalTask       = buildJournalTask('tweet', today, hour, dayNumber);
    ctx.toolManifest      = buildToolManifest();
    ctx.lastToolResult    = loadLastToolResult();
    ctx.engagementSummary = formatEngagementSummary();
  }

  return ctx;
}

module.exports = loadContext;
module.exports.readState = readState;
module.exports.formatCurrentAxes = formatCurrentAxes;
module.exports.formatTopAxes = formatTopAxes;
module.exports.formatQuotedSources = formatQuotedSources;
module.exports.loadActivePlanContext = loadActivePlanContext;
module.exports.buildReadingBlock = buildReadingBlock;
module.exports.buildJournalTask = buildJournalTask;
module.exports.formatCadence = formatCadence;
module.exports.formatCaptureStatus = formatCaptureStatus;

// CLI: dump context as JSON for debugging
if (require.main === module) {
  const ctx = loadContext({
    type:      process.env.PROMPT_TYPE || 'browse',
    cycle:     parseInt(process.env.CYCLE || '1', 10),
    dayNumber: parseInt(process.env.DAY_NUMBER || '1', 10),
    today:     process.env.TODAY || new Date().toISOString().slice(0, 10),
    now:       process.env.NOW   || new Date().toTimeString().slice(0, 5),
    hour:      process.env.HOUR  || String(new Date().getHours()).padStart(2, '0'),
  });
  console.log(JSON.stringify(ctx, null, 2));
}
