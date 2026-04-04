'use strict';

/**
 * runner/lib/gemini_agent.js — Vertex AI Gemini function-calling agent loop
 *
 * Replaces OpenClaw CLI. Sends prompts to Gemini via Vertex AI, handles
 * tool-use loops (LLM requests tool -> execute -> return result -> repeat),
 * and manages browser lifecycle per agent run.
 *
 * Uses:
 *   - gcp_auth.js for Vertex AI OAuth2 tokens
 *   - cdp.js for browser connection (puppeteer-core)
 *   - agent_tools.js for tool declarations and executors
 */

const fs = require('fs');
const path = require('path');
const { getAccessToken, getProjectConfig } = require('../gcp_auth');
const { connectBrowser, getXPage } = require('../cdp');
const { TOOL_EXECUTORS, getBrowseTools, getTweetTools } = require('./agent_tools');
const config = require('./config');

const MODEL = 'gemini-2.5-flash';
const MAX_TURNS = 40;           // max tool-use round-trips before force-stop
const MAX_TIMEOUT_MS = 900_000; // 15 min hard timeout (matches old openclaw limit)

function log(msg) {
  console.log(`[gemini-agent] ${msg}`);
}

// ── System prompt ────────────────────────────────────────────────────────────

function loadSystemPrompt() {
  const agentsPath = path.join(config.PROJECT_ROOT, 'AGENTS.md');
  try {
    return fs.readFileSync(agentsPath, 'utf-8');
  } catch {
    return '';
  }
}

// ── Vertex AI API call ───────────────────────────────────────────────────────

/**
 * Call Gemini generateContent on Vertex AI.
 * @param {object} opts
 * @param {Array} opts.contents - conversation messages
 * @param {string} opts.systemInstruction - system prompt text
 * @param {Array} opts.tools - tool declarations
 * @param {string} [opts.thinking] - thinking level: 'high'|'low' or omit
 * @returns {Promise<object>} raw API response
 */
async function callGemini({ contents, systemInstruction, tools, thinking }) {
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${MODEL}:generateContent`;

  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: 8192,
  };

  // Map thinking level to budget
  if (thinking === 'high') {
    generationConfig.thinkingConfig = { thinkingBudget: 8192 };
  } else if (thinking === 'low') {
    generationConfig.thinkingConfig = { thinkingBudget: 2048 };
  } else {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const body = {
    contents,
    generationConfig,
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (tools && tools.length > 0) {
    body.tools = [{ functionDeclarations: tools }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000); // 2 min per API call

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Vertex API HTTP ${res.status}: ${errBody.slice(0, 500)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Extract response parts ───────────────────────────────────────────────────

function extractParts(response) {
  const candidate = response?.candidates?.[0];
  if (!candidate?.content?.parts) return { text: '', functionCalls: [], parts: [] };

  const parts = candidate.content.parts;
  const textParts = parts.filter(p => p.text && !p.thought).map(p => p.text);
  const functionCalls = parts.filter(p => p.functionCall);

  return {
    text: textParts.join(''),
    functionCalls,
    parts,
    finishReason: candidate.finishReason,
  };
}

// ── Main agent run ───────────────────────────────────────────────────────────

/**
 * agentRun — replacement for openclaw agent CLI.
 *
 * Runs a Gemini function-calling loop:
 *   1. Send prompt + system instruction + tool declarations
 *   2. If Gemini returns function calls, execute them and send results back
 *   3. Repeat until Gemini returns text-only (no more tool calls) or max turns
 *
 * @param {object} opts
 * @param {string} opts.agent    - agent name (for logging, e.g. 'x-hunter')
 * @param {string} opts.message  - user prompt
 * @param {string} [opts.thinking] - 'high' | 'low' | undefined
 * @param {boolean} [opts.useBrowser] - whether to connect browser (default true)
 * @param {string} [opts.verbose] - 'on' for verbose logging
 * @returns {Promise<number>} exit code (0 = success)
 */
async function agentRun({ agent, message, thinking, useBrowser = true, verbose }) {
  const startTs = Date.now();
  const deadline = startTs + MAX_TIMEOUT_MS;

  log(`starting agent=${agent} thinking=${thinking || 'none'} browser=${useBrowser}`);

  // Load system prompt
  const systemInstruction = loadSystemPrompt();

  // Select tools based on whether browser is needed
  const tools = useBrowser ? getBrowseTools() : getTweetTools();

  // Connect browser if needed
  let browser = null;
  let page = null;
  if (useBrowser) {
    try {
      browser = await connectBrowser();
      page = await getXPage(browser);
      log('browser connected');
    } catch (err) {
      log(`WARNING: browser connection failed: ${err.message} — restarting Chrome and retrying`);
      try {
        require('./browser').ensureBrowser();
        await new Promise(r => setTimeout(r, 3000));
        browser = await connectBrowser();
        page = await getXPage(browser);
        log('browser reconnected after restart');
      } catch (err2) {
        log(`WARNING: browser reconnect failed: ${err2.message} — proceeding without browser`);
        useBrowser = false;
      }
    }
  }

  const toolCtx = { page };

  // Build initial conversation
  const contents = [
    { role: 'user', parts: [{ text: message }] },
  ];

  let turn = 0;
  let exitCode = 0;

  try {
    while (turn < MAX_TURNS) {
      // Check timeout
      if (Date.now() > deadline) {
        log(`WARNING: exceeded ${MAX_TIMEOUT_MS / 1000}s — force-stopping`);
        exitCode = 1;
        break;
      }

      turn++;
      if (verbose === 'on') {
        log(`turn ${turn}/${MAX_TURNS}`);
      }

      // Call Gemini
      let response;
      try {
        response = await callGemini({
          contents,
          systemInstruction,
          tools: useBrowser ? getBrowseTools() : getTweetTools(),
          thinking,
        });
      } catch (err) {
        log(`ERROR: Gemini API call failed: ${err.message}`);
        // Retry once after a short delay
        if (turn === 1) {
          log('retrying in 5s...');
          await new Promise(r => setTimeout(r, 5000));
          try {
            response = await callGemini({
              contents,
              systemInstruction,
              tools: useBrowser ? getBrowseTools() : getTweetTools(),
              thinking,
            });
          } catch (retryErr) {
            log(`ERROR: retry failed: ${retryErr.message}`);
            exitCode = 1;
            break;
          }
        } else {
          exitCode = 1;
          break;
        }
      }

      const { text, functionCalls, parts, finishReason } = extractParts(response);

      // Log any text output
      if (text && verbose === 'on') {
        // Print to stdout like openclaw did
        process.stdout.write(text);
        if (!text.endsWith('\n')) process.stdout.write('\n');
      }

      // If no function calls, we're done
      if (functionCalls.length === 0) {
        log(`completed in ${turn} turn(s), ${Math.floor((Date.now() - startTs) / 1000)}s`);
        break;
      }

      // Add assistant's response to conversation
      contents.push({ role: 'model', parts });

      // Execute function calls
      const functionResponses = [];
      for (const fc of functionCalls) {
        const { name, args } = fc.functionCall;
        log(`tool: ${name}(${JSON.stringify(args).slice(0, 100)})`);

        const executor = TOOL_EXECUTORS[name];
        let result;
        if (!executor) {
          result = `Unknown tool: ${name}`;
        } else {
          try {
            result = await executor(args || {}, toolCtx);
          } catch (err) {
            result = `Tool error: ${err.message}`;
          }
        }

        // Truncate large results
        if (typeof result === 'string' && result.length > 20000) {
          result = result.slice(0, 20000) + '\n...(truncated)';
        }

        functionResponses.push({
          functionResponse: {
            name,
            response: { result },
          },
        });
      }

      // Add tool results to conversation
      contents.push({ role: 'user', parts: functionResponses });
    }

    if (turn >= MAX_TURNS) {
      log(`WARNING: reached max turns (${MAX_TURNS}) — stopping`);
      exitCode = 1;
    }
  } catch (err) {
    log(`ERROR: unexpected: ${err.message}`);
    exitCode = 1;
  } finally {
    // Disconnect browser (don't close — Chrome stays running for other scripts)
    if (browser) {
      try { browser.disconnect(); } catch {}
    }
  }

  const elapsed = Math.floor((Date.now() - startTs) / 1000);
  log(`agent=${agent} exit=${exitCode} elapsed=${elapsed}s turns=${turn}`);
  return exitCode;
}

// ── Sync wrapper ─────────────────────────────────────────────────────────────

/**
 * agentRunSync — synchronous wrapper matching the old openclaw agent interface.
 *
 * The orchestrator calls this synchronously. We run the async agentRun
 * in a child process to avoid blocking the event loop.
 */
function agentRunSync({ agent, message, thinking, verbose }) {
  const { execFileSync } = require('child_process');

  // Write prompt to a temp file to avoid shell escaping issues
  const tmpPrompt = path.join(config.STATE_DIR, '.agent_prompt.tmp');
  fs.writeFileSync(tmpPrompt, message);

  const args = [
    path.join(__dirname, 'gemini_agent_runner.js'),
    '--agent', agent,
    '--prompt-file', tmpPrompt,
  ];
  if (thinking) args.push('--thinking', thinking);
  if (verbose) args.push('--verbose', verbose);

  try {
    execFileSync('node', args, {
      stdio: 'inherit',
      env: process.env,
      timeout: MAX_TIMEOUT_MS + 30_000, // extra 30s grace
      killSignal: 'SIGKILL',
    });
    return 0;
  } catch (err) {
    if (err.signal === 'SIGKILL') {
      log(`WARNING: agent exceeded ${MAX_TIMEOUT_MS / 1000}s — force-killed`);
    }
    return err.status ?? 1;
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch {}
  }
}

module.exports = { agentRun, agentRunSync };
