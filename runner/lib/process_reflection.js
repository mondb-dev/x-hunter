'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { callVertex } = require('../vertex');

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
  return !!proposal && ['pending', 'building', 'testing'].includes(proposal.status);
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

function buildPrompt({ today, source, checkpointNumber, recentJournals, recentArticles, recentPosts, highConf, historyContext }) {
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

Previous process improvement proposals and their outcomes:
${historyContext}

REFLECTION TASK:
Where did your process fail or fall short recently? What patterns kept emerging
that you had no framework for? What should be built or changed to fix that?

GOOD proposal targets:
- prompt changes that reduce recurring framing errors
- pipeline/state/protocol changes that help you notice, track, or audit patterns
- tooling that lets you gather evidence you currently miss

BAD proposal targets:
- pure content goals like "write more articles" or "post more on X"
- growth/engagement strategy
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
  const prompt = buildPrompt({
    today,
    source,
    checkpointNumber,
    recentJournals,
    recentArticles,
    recentPosts,
    highConf,
    historyContext,
  });

  const result = await callVertex(prompt, 4096);
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
};
