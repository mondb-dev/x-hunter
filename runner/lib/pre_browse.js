'use strict';

/**
 * runner/lib/pre_browse.js — pre-browse pipeline (14 ordered script invocations)
 *
 * Ported 1:1 from run.sh lines ~430-487 (inside the BROWSE elif block,
 * before the prompt construction + agent_run).
 *
 * Order and conditional gating match the bash original exactly.
 * All scripts are invoked synchronously via execSync.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { extractKeywords } = require('../../scraper/analytics');

const PROJECT_ROOT = config.PROJECT_ROOT;
const RUNNER_LOG = config.RUNNER_LOG_PATH;

function log(msg) {
  console.log(`[run] ${msg}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadTopicSummaryRecallQuery() {
  try {
    const content = fs.readFileSync(config.TOPIC_SUMMARY_PATH, 'utf-8');
    return content
      .split('\n')
      .filter(line => /^\d+x\s/.test(line))
      .map(line => line.replace(/^\d+x\s*/, ''))
      .slice(0, 3)
      .join(' ')
      .trim();
  } catch {
    return '';
  }
}

function parseSprintContext() {
  try {
    const raw = fs.readFileSync(config.SPRINT_CONTEXT_PATH, 'utf-8');
    if (!raw.trim() || raw.includes('(no active plan)') || raw.includes('(no active sprint)')) {
      return null;
    }

    const lines = raw.split('\n');
    const planTitle = lines
      .map(line => line.match(/^PLAN:\s+(.+?)\s+\(active\)$/))
      .find(Boolean)?.[1]?.trim() || '';

    const tasks = lines
      .map(line => line.match(/^\s*([▸○])\s*\[(\w+)\]\s+(.+)$/))
      .filter(Boolean)
      .map(match => ({
        marker: match[1],
        type: match[2].trim().toLowerCase(),
        title: match[3].replace(/\[carried\]\s*/g, '').trim(),
      }));

    return { planTitle, tasks };
  } catch {
    return null;
  }
}

function buildSprintBriefRecallQuery() {
  const sprint = parseSprintContext();
  if (!sprint?.planTitle || !Array.isArray(sprint.tasks) || sprint.tasks.length === 0) return '';

  const explicitTask = sprint.tasks.find(task => task.marker === '▸') || null;
  const activeTask = explicitTask || sprint.tasks.find(task => ['write', 'compile'].includes(task.type)) || null;
  if (!activeTask || !['write', 'compile'].includes(activeTask.type)) return '';

  const briefsDoc = readJson(config.RESEARCH_BRIEFS_PATH);
  const briefs = Array.isArray(briefsDoc?.briefs) ? briefsDoc.briefs : [];
  if (!briefs.length) return '';

  const brief = briefs.find(entry => entry.title === sprint.planTitle);
  if (!brief) return '';

  const chunks = [
    brief.title,
    brief.brief,
    brief.compulsion,
    ...(Array.isArray(brief.belief_axes) ? brief.belief_axes : []),
    ...(Array.isArray(brief.research?.open_questions) ? brief.research.open_questions : []),
  ].filter(Boolean);

  const query = extractKeywords(chunks.join('\n'), 8)
    .slice(0, 6)
    .join(' ')
    .trim();

  if (query) {
    const basis = explicitTask ? 'explicit in-progress task' : 'top pending write/compile task';
    log(`sprint-aware recall override: ${activeTask.type} task "${activeTask.title}" (${basis}) → research_briefs`);
  }

  return query;
}

/** Run a node script, logging to runner.log. Failures are swallowed (|| true). */
function runScript(scriptPath, opts = {}) {
  const { env = {}, stdout = 'log', args = '' } = opts;
  const mergedEnv = { ...process.env, ...env };
  const redirect = stdout === 'devnull' ? '> /dev/null 2>&1' : `>> "${RUNNER_LOG}" 2>&1`;
  try {
    execSync(`node "${scriptPath}" ${args} ${redirect}`, {
      env: mergedEnv,
      shell: true,
      stdio: 'ignore',
      timeout: 120_000, // 2-min safety net per script
    });
  } catch {
    // Matches bash `|| true` — failures are logged but don't halt the pipeline
  }
}

/**
 * preBrowse(cycle)
 *
 * Runs the 14-step pre-browse pipeline. Each step matches a block in run.sh,
 * plus deterministic external-source discovery, profiling, and conviction-driven source selection.
 *
 * @param {number} cycle - current cycle number
 */
function preBrowse(cycle) {
  // ── 1. FTS5 integrity check + rebuild if corrupted ─────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/fts_maintain.js'));

  // ── 2. query.js --hours 4 (topic summary + memory index) ──────────────
  runScript(path.join(PROJECT_ROOT, 'scraper/query.js'), { args: '--hours 4', stdout: 'devnull' });

  // ── 3. recall.js (keyword-driven, from topic_summary top 3) ───────────
  let recallQuery = buildSprintBriefRecallQuery() || loadTopicSummaryRecallQuery();

  if (recallQuery) {
    // Sanitise recallQuery — remove shell metacharacters to prevent injection
    const safeQuery = recallQuery.replace(/["`$\\!;|&<>(){}]/g, '');
    runScript(path.join(PROJECT_ROOT, 'runner/recall.js'), { args: `--query "${safeQuery}" --limit 5` });
  } else {
    runScript(path.join(PROJECT_ROOT, 'runner/recall.js'), { args: '--limit 5' });
  }

  // ── 4. curiosity.js (every CURIOSITY_EVERY cycles) ────────────────────
  if (cycle % config.CURIOSITY_EVERY === 0) {
    runScript(path.join(PROJECT_ROOT, 'runner/curiosity.js'), {
      env: { CURIOSITY_CYCLE: String(cycle), CURIOSITY_EVERY: String(config.CURIOSITY_EVERY) },
    });

    // ── 4b. search_curiosity.js — web search for directive topic ─────────
    // Co-fires with curiosity; adds top search result URLs to reading_queue
    runScript(path.join(PROJECT_ROOT, 'runner/search_curiosity.js'));

    // ── 5. cluster_axes.js (co-fires with curiosity) ────────────────────
    runScript(path.join(PROJECT_ROOT, 'runner/cluster_axes.js'));
  }

  // ── 4c. rss_collect.js — pull news RSS feeds into feed_digest ────────
  // Runs every browse cycle; self-gated internally (1h cooldown per feed)
  runScript(path.join(PROJECT_ROOT, 'scraper/rss_collect.js'));

  // ── 6. comment_candidates.js ──────────────────────────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/comment_candidates.js'));

  // ── 7. discourse_scan.js → discourse_anchors.jsonl ────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/discourse_scan.js'));

  // ── 8. discourse_digest.js → discourse_digest.txt ─────────────────────
  runScript(path.join(PROJECT_ROOT, 'runner/discourse_digest.js'));

  // ── 9. external_source_discovery.js (mechanical registry refresh) ─────
  runScript(path.join(PROJECT_ROOT, 'runner/external_source_discovery.js'));

  // ── 10. external_source_profile.js (deterministic live profiling) ──────
  runScript(path.join(PROJECT_ROOT, 'runner/external_source_profile.js'));

  // ── 11. source_selector.js (periodic external source queueing) ────────
  runScript(path.join(PROJECT_ROOT, 'runner/source_selector.js'), {
    env: { SOURCE_SELECT_CYCLE: String(cycle) },
  });

  // ── 12. reading_queue.js (emit reading URL for this cycle) ────────────
  runScript(path.join(PROJECT_ROOT, 'runner/reading_queue.js'), {
    env: { READING_CYCLE: String(cycle) },
  });

  // ── 13. deep_dive_detector.js (every 6 cycles) ───────────────────────
  if (cycle % 6 === 0) {
    runScript(path.join(PROJECT_ROOT, 'runner/deep_dive_detector.js'), {
      env: { READING_CYCLE: String(cycle) },
    });
  }

  // ── 14. prefetch_url.js (pre-load reading/curiosity URL in browser) ───
  runScript(path.join(PROJECT_ROOT, 'runner/prefetch_url.js'), {
    env: { PREFETCH_CYCLE: String(cycle) },
  });
}

module.exports = {
  preBrowse,
  buildSprintBriefRecallQuery,
  loadTopicSummaryRecallQuery,
  parseSprintContext,
};
