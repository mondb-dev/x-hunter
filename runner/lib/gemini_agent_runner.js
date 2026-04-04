#!/usr/bin/env node
'use strict';

/**
 * runner/lib/gemini_agent_runner.js — Child process entry point for agentRunSync
 *
 * Runs the async agentRun() in a child process so the synchronous orchestrator
 * can call it via execFileSync without blocking the event loop.
 *
 * Usage:
 *   node gemini_agent_runner.js --agent x-hunter --prompt-file /tmp/prompt.txt [--thinking high] [--verbose on]
 */

const fs = require('fs');
const path = require('path');

// Load .env
const ROOT = path.resolve(__dirname, '../..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { agentRun } = require('./gemini_agent');

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const agent = getArg('agent') || 'x-hunter';
const promptFile = getArg('prompt-file');
const thinking = getArg('thinking');
const verbose = getArg('verbose');

if (!promptFile || !fs.existsSync(promptFile)) {
  console.error('[gemini-agent-runner] --prompt-file is required and must exist');
  process.exit(1);
}

const message = fs.readFileSync(promptFile, 'utf-8');

// Determine if browser is needed based on agent name and prompt content
// Tweet agent (x-hunter-tweet) and prompts with "no browser" don't need browser
const useBrowser = agent !== 'x-hunter-tweet' && !message.includes('No browser tool');

(async () => {
  try {
    const exitCode = await agentRun({ agent, message, thinking, useBrowser, verbose });
    process.exit(exitCode);
  } catch (err) {
    console.error(`[gemini-agent-runner] fatal: ${err.message}`);
    process.exit(1);
  }
})();
