'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { reason } = require('./compose');

const ROOT = config.PROJECT_ROOT;

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function stripHtml(html) {
  return html
    .replace(/<sup>[\s\S]*?<\/sup>/g, '')
    .replace(/<a [^>]*>([\s\S]*?)<\/a>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSection(html, klass) {
  const re = new RegExp(`<section class="${klass}">([\\s\\S]*?)<\\/section>`, 'i');
  const m = html.match(re);
  return m ? stripHtml(m[1]) : '';
}

function loadRecentJournals(limit = 12, perEntryChars = 700) {
  const journalsDir = path.join(ROOT, 'journals');
  if (!fs.existsSync(journalsDir)) return '';

  const files = fs.readdirSync(journalsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f))
    .sort()
    .slice(-limit);

  return files.map((filename) => {
    const raw = fs.readFileSync(path.join(journalsDir, filename), 'utf-8');
    const stream = extractSection(raw, 'stream');
    const tensions = extractSection(raw, 'tensions');
    const stamp = filename.replace('.html', '').replace('_', ' h');
    const body = [stream && `obs: ${stream}`, tensions && `tensions: ${tensions}`]
      .filter(Boolean)
      .join('\n')
      .slice(0, perEntryChars);
    return `### ${stamp}\n${body}`;
  }).filter(Boolean).join('\n\n');
}

function loadRecentArticles(limit = 3, perEntryChars = 1500) {
  const articlesDir = path.join(ROOT, 'articles');
  if (!fs.existsSync(articlesDir)) return '';

  const files = fs.readdirSync(articlesDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .slice(-limit);

  return files.map((filename) => {
    const raw = fs.readFileSync(path.join(articlesDir, filename), 'utf-8');
    const body = raw.replace(/^---[\s\S]*?---\n/, '').trim();
    return `### ${filename.replace('.md', '')}\n${body.slice(0, perEntryChars)}`;
  }).join('\n\n---\n\n');
}

function loadRecentPosts(limit = 20) {
  const data = loadJson(config.POSTS_LOG_PATH);
  const posts = Array.isArray(data) ? data : (data?.posts || []);
  if (!posts.length) return '(no posts yet)';

  return posts.slice(-limit).map((p) => {
    const when = (p.posted_at || p.date || '').slice(0, 16);
    const content = (p.content || p.text || '').replace(/\s+/g, ' ').slice(0, 240);
    const url = p.tweet_url && p.tweet_url !== 'posted' ? ` ${p.tweet_url}` : '';
    return `- [${p.type}] ${when}${url}\n  ${content}`;
  }).join('\n');
}

function formatHighConfidenceAxes() {
  const ontology = loadJson(config.ONTOLOGY_PATH);
  const axes = ontology?.axes || [];
  return [...axes]
    .filter((axis) => (axis.confidence || 0) > 0)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 5)
    .map((axis) =>
      `- \`${axis.id}\`: conf ${((axis.confidence || 0) * 100).toFixed(0)}%, score ${(axis.score || 0).toFixed(3)}`
    )
    .join('\n') || '- (none with confidence > 0 yet)';
}

/**
 * Summarize PREDICTION performance so reflection can propose forecast-function
 * fixes for the builder to implement. This is the bridge that lets the builder
 * "own" prediction self-improvement: reflection sees the measured failure (via
 * the calibration + skill libs) and turns it into a buildable proposal.
 */
function loadPredictionPerformance() {
  const logPath = path.join(ROOT, 'state', 'prediction_log.jsonl');
  let preds = [];
  try {
    preds = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return '(no prediction log yet)'; }
  if (!preds.length) return '(no predictions yet)';

  let cal = null, skill = null;
  try { cal = require('./prediction_calibration').computeCalibration(preds); } catch {}
  try { skill = require('./prediction_skill').computeSkill(preds); } catch {}

  const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  const pending = preds.filter((p) => (p.resolution_status || 'pending') === 'pending').length;
  const lines = [`${preds.length} predictions logged, ${cal?.n || 0} resolved-with-confidence, ${pending} pending.`];
  if (cal && cal.n) {
    lines.push(`Actual hit-rate ${pct(cal.baseRate)} vs mean stated confidence ${pct(cal.meanStated)} — overconfidence gap ${cal.overconfidenceGap > 0 ? '+' : ''}${Math.round((cal.overconfidenceGap || 0) * 100)}pts. Brier ${cal.brierRaw?.toFixed(3)} (raw) → ${cal.brierCalibrated?.toFixed(3)} (calibrated).`);
  }
  if (skill && skill.recentFailures && skill.recentFailures.length) {
    lines.push('Recent misses (verbatim resolution notes — look for the failure PATTERN):');
    for (const f of skill.recentFailures.slice(0, 4)) lines.push(`  - [${f.status}] "${f.prediction.slice(0, 90)}" → ${f.note}`);
  }
  if (skill && skill.perAxis) {
    const edged = Object.entries(skill.perAxis).filter(([, v]) => v.edge === 'edge').map(([l]) => l);
    const avoid = Object.entries(skill.perAxis).filter(([, v]) => v.edge === 'avoid').map(([l]) => l);
    if (edged.length || avoid.length) lines.push(`Demonstrated edge on [${edged.join(', ') || 'none'}]; no edge on [${avoid.join(', ') || 'none'}].`);
  }
  return lines.join('\n');
}

function loadProposalHistory(limit = 5) {
  const history = loadJson(config.PROPOSAL_HISTORY_PATH);
  const proposals = Array.isArray(history?.proposals) ? history.proposals : [];
  if (proposals.length === 0) return '(no previous proposals)';

  return proposals.slice(-limit).map((proposal) =>
    `- [${proposal.status}] "${proposal.title}" — ${proposal.resolution_notes || proposal.resolution || 'no notes'}`
  ).join('\n');
}

function hasActiveProposal() {
  const proposal = loadJson(config.PROCESS_PROPOSAL_PATH);
  if (!proposal || !['pending', 'building', 'testing'].includes(proposal.status)) return false;
  // Auto-expire a proposal stuck 'pending' too long so a stale/un-buildable one
  // can't deadlock reflection forever (the builder side has its own 7d expiry;
  // this frees reflection sooner). Tunable via PROPOSAL_MAX_AGE_DAYS.
  if (proposal.status === 'pending') {
    const created = Date.parse(proposal.created_at || proposal.timestamp || 0);
    const ageDays = created ? (Date.now() - created) / 86_400_000 : 0;
    const maxDays = Number(process.env.PROPOSAL_MAX_AGE_DAYS) || 5;
    if (ageDays >= maxDays) {
      proposal.status = 'expired';
      proposal.resolution = `Auto-expired after ${maxDays}d pending without a build.`;
      proposal.resolved_at = new Date().toISOString();
      try { require('fs').writeFileSync(config.PROCESS_PROPOSAL_PATH, JSON.stringify(proposal, null, 2)); } catch {}
      return false;
    }
  }
  return true;
}

function loadReflectionState() {
  return loadJson(config.PROCESS_REFLECTION_STATE_PATH) || {
    last_reflection_at: null,
    last_source: null,
    last_outcome: null,
  };
}

function saveReflectionState(patch) {
  const state = {
    ...loadReflectionState(),
    ...patch,
  };
  writeJson(config.PROCESS_REFLECTION_STATE_PATH, state);
}

function reflectionDue(nowMs, minIntervalMs) {
  const state = loadReflectionState();
  const last = state.last_reflection_at ? new Date(state.last_reflection_at).getTime() : 0;
  if (!last) return true;
  return nowMs - last >= minIntervalMs;
}

function buildPrompt({ today, source, checkpointNumber, recentJournals, recentArticles, recentPosts, highConf, historyContext, predictionPerformance, operatingCost }) {
  const sourceLine = checkpointNumber
    ? `You are reflecting on your own process at Checkpoint ${checkpointNumber} (${today}).`
    : `You are reflecting on your own process in the daily maintenance cycle (${today}).`;

  return `You are Sebastian D. Hunter, an autonomous AI agent that browses X/Twitter and forms beliefs.
${sourceLine}

Your current belief state (top axes):
${highConf || '(no active axes)'}

Recent journal entries (raw cycle observations — what you noticed, what felt unresolved):
${recentJournals.slice(0, 9000) || '(none)'}

Recent articles you wrote (where synthesis succeeded or fell flat):
${recentArticles.slice(0, 5000) || '(none)'}

Recent posts you committed to publicly (tweets, quotes, replies):
${recentPosts.slice(0, 4000) || '(none)'}

Your PREDICTION performance — a measured, high-signal process surface. You make
forecasts (runner/predictive_prompt.js) and auto-resolve them (runner/prediction_resolution.js),
with calibration (lib/prediction_calibration.js) and skill (lib/prediction_skill.js) feedback:
${predictionPerformance || '(no predictions yet)'}

Your OPERATING COST — what it takes to keep you running (LLM spend is metered live;
hosting/domain are fixed; archival is funded by a SOL wallet):
${operatingCost || '(cost model not available yet)'}

Previous process improvement proposals and their outcomes:
${historyContext}

REFLECTION TASK:
Where did your process fail or fall short recently? What patterns kept emerging
that you had no framework for? What should be built or changed to fix that?

GOOD proposal targets:
- prompt changes that reduce recurring framing errors
- pipeline/state/protocol changes that help you notice, track, or audit patterns
- tooling that lets you gather evidence you currently miss
- FORECASTING fixes: if your prediction performance above shows overconfidence,
  vague/unfalsifiable forecasts, or a resolver that keeps returning "no evidence
  found", propose a concrete change to predictive_prompt.js (how predictions are
  formed/gated), prediction_resolution.js (how outcomes are verified — e.g. web
  search instead of stale axis evidence), or the calibration/skill libs. These
  files are yours to change.

SUSTAINABILITY: you now see your running cost above. If sustainability is a real
constraint, a GOOD proposal is a concrete, HONEST, buildable step — a transparent
cost/burn dashboard, a visible support/tip link, or packaging your existing
research (deep_research) as an offering where people get real value for what they
pay. NEVER propose anything that extracts money from your audience's trust:
no speculative token launches, no memecoins, no coordinated buys/"buybacks", no
price manipulation, no undisclosed promotion. Those betray the integrity your
whole vocation is built on and harm the people who follow you.

BAD proposal targets:
- pure content goals like "write more articles" or "post more on X"
- growth/engagement strategy
- speculative/financial schemes (tokens, memecoins, pumps) — hard prohibition
- vague wishes without a concrete build surface

If your first instinct is a content desire, REFRAME it as a system change.
Example: instead of "write articles on X", propose "build an article promotion path".

Think about:
- Information you needed but could not get
- Patterns you noticed but had no way to track
- Repeated wording/voice failures you should suppress
- Processes that felt broken or incomplete
- Things you wanted to do but your pipeline didn't support

If you identify a SPECIFIC, actionable gap, output a JSON proposal block like this:

\`\`\`json
{
  "id": "proposal_<slug>_${Date.now()}",
  "status": "pending",
  "title": "Short description of what to build",
  "problem": "What gap or failure pattern you observed",
  "evidence": ["specific journal refs, dates, failure descriptions"],
  "proposed_solution": "What to build — conceptual, not code",
  "affected_files": ["best-guess list of files to modify or create"],
  "scope": "protocol|pipeline|prompt|state",
  "estimated_risk": "low|medium|high",
  "created_at": "${new Date().toISOString()}",
  "resolved_at": null,
  "resolution": null
}
\`\`\`

CONSTRAINTS:
- Maximum 1 proposal
- Must cite specific evidence (not vague feelings)
- Proposal must be a buildable system change, not a content preference
- Do NOT propose engagement optimization or audience growth tactics
- You CANNOT propose changes to: SOUL.md, IDENTITY.md, AGENTS.md §1-§11, orchestrator.js, lib/agent.js, lib/git.js, lib/state.js, .env, builder_pipeline.js, builder_vertex.js

If no proposal is warranted, write a short reflection paragraph with no JSON block.`;
}

function extractProposal(text) {
  const match = text.match(/```json\s*\n([\s\S]*?)```/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

async function runProcessReflection({
  today = new Date().toISOString().slice(0, 10),
  source = 'manual',
  checkpointNumber = null,
  minIntervalHours = 24,
  journalsLimit = 12,
  articlesLimit = 3,
  postsLimit = 20,
} = {}) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const minIntervalMs = minIntervalHours * 60 * 60 * 1000;

  if (hasActiveProposal()) {
    saveReflectionState({
      last_source: source,
      last_outcome: 'skipped_active_proposal',
    });
    return { status: 'skipped', reason: 'active proposal exists' };
  }

  if (!reflectionDue(nowMs, minIntervalMs)) {
    return { status: 'skipped', reason: `last reflection < ${minIntervalHours}h ago` };
  }

  const highConf = formatHighConfidenceAxes();
  const recentJournals = loadRecentJournals(journalsLimit);
  const recentArticles = loadRecentArticles(articlesLimit);
  const recentPosts = loadRecentPosts(postsLimit);
  const historyContext = loadProposalHistory();
  const predictionPerformance = loadPredictionPerformance();
  const operatingCost = (() => {
    try { const oc = require('./operating_cost'); return oc.summaryText(oc.compute({ write: true })); }
    catch { return ''; }
  })();
  const prompt = buildPrompt({
    today,
    source,
    checkpointNumber,
    recentJournals,
    recentArticles,
    recentPosts,
    highConf,
    historyContext,
    predictionPerformance,
    operatingCost,
  });

  const result = await reason(prompt, { maxTokens: 4096, tag: "process_reflection" });
  saveReflectionState({
    last_reflection_at: nowIso,
    last_source: source,
    last_outcome: 'completed',
  });

  let proposal = null;
  try {
    proposal = extractProposal(result);
  } catch (err) {
    return { status: 'failed', reason: `could not parse proposal JSON: ${err.message}` };
  }

  if (!proposal) {
    return { status: 'completed', reason: 'no proposal generated' };
  }

  if (!proposal.id || !proposal.title || !proposal.problem || !proposal.scope
      || !/^proposal_[a-z0-9_]+$/i.test(proposal.id)) {
    return { status: 'failed', reason: 'proposal JSON missing required fields' };
  }

  proposal.status = 'pending';
  proposal.created_at = nowIso;
  fs.writeFileSync(config.PROCESS_PROPOSAL_PATH, JSON.stringify(proposal, null, 2));
  return {
    status: 'completed',
    reason: 'proposal written',
    proposalTitle: proposal.title,
    proposalId: proposal.id,
  };
}

module.exports = {
  runProcessReflection,
  loadRecentJournals,
  loadRecentArticles,
  loadRecentPosts,
  formatHighConfidenceAxes,
  loadPredictionPerformance,
};
