'use strict';

/**
 * runner/lib/prompts/builder.js — Prompt template for the builder agent
 *
 * The builder agent receives a process proposal from Sebastian and implements
 * the code changes. It writes files to staging/ mirroring the project structure.
 */

const fs   = require('fs');
const path = require('path');
const config = require('../config');
const { buildToolManifest } = require('../tools');

const ROOT = config.PROJECT_ROOT;

// Files the builder is NEVER allowed to modify (hardcoded guardrail)
const PROTECTED_FILES = [
  'runner/orchestrator.js',
  'runner/lib/agent.js',
  'runner/lib/git.js',
  'runner/lib/state.js',
  'runner/lib/config.js',
  'runner/lib/sandbox.js',
  'runner/tool_guard.js',
  'runner/builder_vertex.js',
  'runner/builder_pipeline.js',
  'runner/sandbox_run.js',
  'runner/tool_catalog.js',
  'runner/lib/prompts/builder.js',
  'runner/lib/tools.js',
  '.env',
  'SOUL.md',
  'IDENTITY.md',
];

/**
 * Load a tail of lines from a file. Returns empty string on failure.
 */
function tailFile(filePath, lines = 60) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').slice(-lines).join('\n').trim();
  } catch { return ''; }
}

/**
 * Load last N entries from a .jsonl file as pretty JSON array.
 */
function tailJsonl(filePath, n = 8) {
  try {
    const entries = fs.readFileSync(filePath, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .slice(-n)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return JSON.stringify(entries, null, 2);
  } catch { return ''; }
}

/**
 * Load a JSON state file, pretty-printed and capped at maxChars.
 */
function loadJson(filePath, maxChars = 1500) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.slice(0, maxChars) + (raw.length > maxChars ? '\n... (truncated)' : '');
  } catch { return ''; }
}

/**
 * Build the system monitoring snapshot for the builder.
 * Gives the builder eyes on actual runtime state so proposals
 * are grounded in what the system is doing right now.
 */
function loadMonitoringContext() {
  const STATE = path.join(ROOT, 'state');
  const LOG   = path.join(ROOT, 'runner', 'runner.log');

  const sections = [];

  // runner.log — last 80 lines (errors, warnings, cycle activity)
  const log = tailFile(LOG, 80);
  if (log) sections.push(`### runner.log (last 80 lines)\n\`\`\`\n${log}\n\`\`\``);

  // health_state.json — system health metrics
  const health = loadJson(path.join(STATE, 'health_state.json'));
  if (health) sections.push(`### state/health_state.json\n\`\`\`json\n${health}\n\`\`\``);

  // critique.md — last coherence evaluation
  const critique = tailFile(path.join(STATE, 'critique.md'), 30);
  if (critique) sections.push(`### state/critique.md (last 30 lines)\n\`\`\`\n${critique}\n\`\`\``);

  // critique_history.jsonl — last 6 critique entries (coherence trend)
  const critiqueHistory = tailJsonl(path.join(STATE, 'critique_history.jsonl'), 6);
  if (critiqueHistory) sections.push(`### state/critique_history.jsonl (last 6)\n\`\`\`json\n${critiqueHistory}\n\`\`\``);

  // signal_log.jsonl — last 6 signal detection results
  const signalLog = tailJsonl(path.join(STATE, 'signal_log.jsonl'), 6);
  if (signalLog) sections.push(`### state/signal_log.jsonl (last 6)\n\`\`\`json\n${signalLog}\n\`\`\``);

  // landmark_state.json — landmark pipeline status
  const landmarkState = loadJson(path.join(STATE, 'landmark_state.json'));
  if (landmarkState) sections.push(`### state/landmark_state.json\n\`\`\`json\n${landmarkState}\n\`\`\``);

  // posts_log.json — last 5 posts (success/failure rates)
  try {
    const raw = fs.readFileSync(path.join(STATE, 'posts_log.json'), 'utf-8').replace(/\\'/g, "'");
    const posts = (JSON.parse(raw).posts || []).slice(-5);
    sections.push(`### state/posts_log.json (last 5 posts)\n\`\`\`json\n${JSON.stringify(posts, null, 2)}\n\`\`\``);
  } catch {}

  // article_meta.md — meta proposal from last landmark article
  const articleMeta = tailFile(path.join(STATE, 'article_meta.md'), 20);
  if (articleMeta) sections.push(`### state/article_meta.md\n\`\`\`\n${articleMeta}\n\`\`\``);

  return sections.join('\n\n') || '(no monitoring data available)';
}

/**
 * Build the builder prompt from a proposal + context files.
 *
 * @param {Object} opts
 * @param {Object} opts.proposal        - The process_proposal.json content
 * @param {Object[]} opts.previousAttempts - Past failed attempts for this proposal
 * @returns {string} prompt
 */
function buildBuilderPrompt({ proposal, previousAttempts = [] }) {
  // Load AGENTS.md and ARCHITECTURE.md
  let agentsMd = '';
  try { agentsMd = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf-8'); } catch {}

  let archMd = '';
  try { archMd = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf-8'); } catch {}

  // Load relevant source files based on scope + affected_files
  const sourceFiles = loadRelevantFiles(proposal);

  // Load tool manifest so builder knows what already exists
  const toolsManifest = buildToolManifest();

  // Load live monitoring snapshot
  const monitoringContext = loadMonitoringContext();

  // Build previous attempts context
  let attemptsSection = '';
  if (previousAttempts.length > 0) {
    attemptsSection = '\n## Previous failed attempts\n\n' +
      previousAttempts.map((a, i) =>
        `### Attempt ${i + 1}\n` +
        `**Status:** ${a.status}\n` +
        `**Resolution:** ${a.resolution_notes || 'unknown'}\n` +
        `**Files changed:** ${(a.files_changed || []).join(', ')}\n`
      ).join('\n');
  }

  const prompt = `You are a builder agent for the Sebastian D. Hunter project.
Your job is to implement a process improvement that Sebastian identified.

## Your constraints

1. You write files to the staging/ directory, mirroring the project structure.
   - New file: staging/runner/new_script.js → will become runner/new_script.js
   - Modified file: staging/runner/existing.js → full replacement of runner/existing.js
2. You MUST also write staging/manifest.json describing your changes.
3. You CANNOT modify these protected files: ${PROTECTED_FILES.join(', ')}
4. Maximum 8 files per proposal.
5. Maximum 500 lines per file.
6. You can only CREATE new files or MODIFY existing files. No deletions.
7. Write working, tested Node.js code that follows the project's existing patterns.
8. Use 'use strict' and require() (CommonJS) — no ES modules.
9. CRITICAL: Use ONLY Node.js built-in modules (fs, path, crypto, etc.) or packages already
   listed in runner/package.json. NEVER require mock-fs, jest, mocha, sinon, tape, chai, or
   any test framework. If a package is not already installed, do not use it — the build will fail.
10. ALL file paths in staging/ must mirror the REAL project structure. The project uses runner/
   not src/. Example: staging/runner/tools/my_tool.js → becomes runner/tools/my_tool.js.
   Do NOT invent directories like src/, lib/, or pipelines/ that do not exist in the repo.

## The proposal

\`\`\`json
${JSON.stringify(proposal, null, 2)}
\`\`\`
${attemptsSection}
## Project constitution (AGENTS.md)

${agentsMd.slice(0, 8000)}
${agentsMd.length > 8000 ? '\n... (truncated — full file is ' + agentsMd.length + ' chars)\n' : ''}

## Architecture overview

${archMd.slice(0, 4000)}
${archMd.length > 4000 ? '\n... (truncated)\n' : ''}

## Registered tools

These tools already exist in the tools/ directory. When building new tools,
check this list first — extend existing tools rather than duplicating.
If creating a new tool, follow the same interface contract.

${toolsManifest}

## Tool interface contract

Each tool in tools/ must be a CommonJS module exporting:
  - name (string, required) — unique identifier, snake_case
  - description (string, required) — one-line summary
  - execute(args, context) (sync function, required) — returns result object
  - capabilities (object, required) — declares allowed state/ reads, writes, and nested tool calls
  - parameters (object, optional) — JSON schema for args validation
  - version (string, optional) — semver
  - tags (string[], optional) — for categorization

The execute function receives (args, context) where context has:
  - config: the full config module
  - callTool(name, args): call another registered tool (max depth 3)
  - readState(filePath): read an allowlisted state file (returns string)
  - writeState(filePath, content): write an allowlisted state file
  - cycle: current cycle number
  - today: YYYY-MM-DD string

Tools MUST be synchronous — do not return Promises.
Tools execute inside a bubblewrap sandbox with:
  - no network access
  - project files mounted read-only
  - only a scratch copy of allowlisted state/ files mounted read-write

Capabilities format:
  - capabilities.read: array of exact state paths or prefixes ending in /**, e.g. ["state/ontology.json", "state/scratch/**"]
  - capabilities.write: same format, for files the tool may create or modify
  - capabilities.call_tools: optional array of tool names this tool may call via callTool()

Do not rely on raw fs access outside declared capabilities. Use context.readState() and context.writeState() for state files.

## System monitoring snapshot

This is the live state of the system at the time this proposal is being implemented.
Use it to understand what is actually failing, what is working, and what the system
has been doing recently. These files are READ-ONLY — do not write to them in your implementation.

Available monitoring files you can reference in your reasoning:
- \`runner/runner.log\` — runtime errors, warnings, cycle activity
- \`state/health_state.json\` — system health metrics
- \`state/critique.md\` — last coherence evaluation of Sebastian's output
- \`state/critique_history.jsonl\` — coherence trend over recent cycles
- \`state/signal_log.jsonl\` — recent signal detection results
- \`state/landmark_state.json\` — landmark pipeline status and counters
- \`state/posts_log.json\` — recent post history (success/failure)
- \`state/article_meta.md\` — meta proposal from last landmark article

${monitoringContext}

## Relevant source files

${sourceFiles}

## Output format

Write each file as a fenced code block with the staging path as header:

### staging/path/to/file.js
\`\`\`javascript
// file content here
\`\`\`

### staging/manifest.json
\`\`\`json
{
  "proposal_id": "${proposal.id}",
  "files": [
    { "path": "relative/path.js", "action": "create|modify" }
  ],
  "test_commands": ["node runner/new_script.js --dry-run"],
  "rollback_safe": true
}
\`\`\`

Write the complete, working code now. Do not explain — just produce the files.`;

  return prompt;
}

/**
 * Load relevant source files based on proposal scope + affected_files.
 */
function loadRelevantFiles(proposal) {
  const files = new Set(proposal.affected_files || []);

  // Add scope-implied files
  switch (proposal.scope) {
    case 'protocol':
      files.add('AGENTS.md');
      break;
    case 'pipeline':
      // Already covered by affected_files
      break;
    case 'prompt':
      files.add('runner/lib/prompts/browse.js');
      files.add('runner/lib/prompts/context.js');
      break;
    case 'state':
      break;
  }

  // prompt-scope proposals modify context/browse loaders which are large files;
  // give the builder more headroom to avoid truncating critical sections
  const charLimit = proposal.scope === 'prompt' ? 12000 : 6000;

  const sections = [];
  for (const rel of files) {
    // Load file content so the builder can see existing patterns
    const absPath = path.join(ROOT, rel);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const truncated = content.length > charLimit
        ? content.slice(0, charLimit) + `\n... (truncated at ${charLimit} chars)`
        : content;
      sections.push(`### ${rel}\n\`\`\`\n${truncated}\n\`\`\``);
    } catch {
      sections.push(`### ${rel}\n(file not found — this is a new file to create)`);
    }
  }

  return sections.join('\n\n') || '(no specific files referenced)';
}

module.exports = { buildBuilderPrompt, PROTECTED_FILES };
