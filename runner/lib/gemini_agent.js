'use strict';

/**
 * runner/lib/gemini_agent.js — Ollama local LLM function-calling agent loop
 *
 * Drop-in replacement for the Vertex AI Gemini backend.
 * Uses Ollama's OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Same exports: agentRun, agentRunSync
 */

const fs = require('fs');
const path = require('path');
const { connectBrowser, getXPage } = require('../cdp');
const { TOOL_EXECUTORS, getBrowseTools, getTweetTools, sanitizeToolResult } = require('./agent_tools');
const config = require('./config');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'gpt-4o-mini';
const IS_VERTEX = OLLAMA_BASE_URL.includes('aiplatform.googleapis.com');
function resolveApiKey() {
  if (IS_VERTEX) return ''; // Vertex uses ADC tokens, fetched per-request
  const url = OLLAMA_BASE_URL;
  if (url.includes('openai.com')) return process.env.OPENAI_API_KEY || process.env.OPEN_AI_API_KEY || '';
  if (url.includes('x.ai'))      return process.env.GROK_API_KEY || '';
  return ''; // local Ollama — no key needed
}
const API_KEY = resolveApiKey();
const { getAccessToken } = IS_VERTEX ? require('../gcp_auth') : { getAccessToken: null };
const MAX_TURNS = 40;
const MAX_TIMEOUT_MS = 900_000; // 15 min

function log(msg) {
  console.log(`[gemini-agent] ${msg}`);
}

// ── System prompt ─────────────────────────────────────────────────────────────

function loadSystemPrompt() {
  const agentsPath = path.join(config.PROJECT_ROOT, 'AGENTS.md');
  let base = '';
  try {
    base = fs.readFileSync(agentsPath, 'utf-8');
  } catch {
    base = '';
  }
  return base + '\n\n---\n' +
    'CRITICAL — TOOL USE RULES:\n' +
    '1. You MUST call write_file() to save every file. Never output file contents as text or markdown.\n' +
    '2. Files are NOT saved unless you explicitly call write_file(path, content).\n' +
    '3. After completing all observations, call write_file for each required file, then stop.\n' +
    '4. Do not explain what you would write — just call write_file and write it.\n';
}

// ── Tool schema conversion (Gemini → OpenAI format) ───────────────────────────

function convertSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (out.type && typeof out.type === 'string') out.type = out.type.toLowerCase();
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, convertSchema(v)])
    );
  }
  if (out.items) out.items = convertSchema(out.items);
  return out;
}

function toOpenAITools(geminiDeclarations) {
  return geminiDeclarations.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: convertSchema(t.parameters) || { type: 'object', properties: {} },
    },
  }));
}

// ── Ollama API call ───────────────────────────────────────────────────────────

async function callOllama({ messages, tools, model }) {
  const isOllama = OLLAMA_BASE_URL.includes('localhost') || OLLAMA_BASE_URL.includes('127.0.0.1');
  const body = {
    model: model || MODEL,
    messages,
    stream: false,
    ...(isOllama ? { options: { temperature: 0.7 } } : {}),
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (IS_VERTEX) {
    const token = await getAccessToken();
    headers['Authorization'] = 'Bearer ' + token;
  } else if (API_KEY) {
    headers['Authorization'] = 'Bearer ' + API_KEY;
  }

  const MAX_RETRIES = 4;
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);

    try {
      // Vertex OpenAI-compatible endpoint already includes the full path up to /openapi
      // so we append /chat/completions only; other providers need /v1/chat/completions
      const chatPath = IS_VERTEX ? '/chat/completions' : '/v1/chat/completions';
      const res = await fetch(`${OLLAMA_BASE_URL}${chatPath}`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      clearTimeout(timer);

      if (res.status === 429) {
        const errBody = await res.text().catch(() => '');
        const waitMatch = errBody.match(/try again in ([\d.]+)s/i);
        const waitMs = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 1000 : (attempt + 1) * 8000;
        log(`429 rate limit — waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        lastErr = new Error(`Ollama HTTP 429: ${errBody.slice(0, 300)}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        clearTimeout(timer);
        const errBody = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (err.message && err.message.startsWith('Ollama HTTP')) throw err;
      throw err;
    }
  }

  throw lastErr;
}

// ── Main agent run ─────────────────────────────────────────────────────────────

async function agentRun({ agent, message, thinking, useBrowser = true, verbose, model }) {
  const startTs = Date.now();
  const deadline = startTs + MAX_TIMEOUT_MS;

  log(`starting agent=${agent} thinking=${thinking || 'none'} browser=${useBrowser} model=${model || MODEL}`);

  const systemInstruction = loadSystemPrompt();
  const geminiTools = useBrowser ? getBrowseTools() : getTweetTools();
  const tools = toOpenAITools(geminiTools);

  // Connect browser
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

  // Build initial messages (OpenAI format)
  const messages = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: message });

  let turn = 0;
  let exitCode = 0;
  let allText = '';
  let writeFileCalled = false;
  let toolNudgeSent = false; // only nudge once

  try {
    while (turn < MAX_TURNS) {
      if (Date.now() > deadline) {
        log(`WARNING: exceeded ${MAX_TIMEOUT_MS / 1000}s — force-stopping`);
        exitCode = 1;
        break;
      }

      turn++;
      log(`turn ${turn}/${MAX_TURNS}`);

      // Call Ollama
      let response;
      try {
        response = await callOllama({
          messages,
          tools: useBrowser ? toOpenAITools(getBrowseTools()) : toOpenAITools(getTweetTools()),
          model,
        });
      } catch (err) {
        log(`ERROR: Ollama API call failed: ${err.message}`);
        exitCode = 1;
        break;
      }

      const choice = response?.choices?.[0];
      if (!choice) {
        log('ERROR: empty response from Ollama');
        exitCode = 1;
        break;
      }

      const { content, tool_calls, finish_reason } = choice.message;

      if (content) {
        allText += content;
        if (verbose === 'on') {
          process.stdout.write(content);
          if (!content.endsWith('\n')) process.stdout.write('\n');
        }
      }

      // No tool calls — check if we should nudge the model to use write_file
      if (!tool_calls || tool_calls.length === 0) {
        if (!writeFileCalled && !toolNudgeSent && allText.length > 200) {
          // Model produced text but no tool calls — nudge it to call write_file
          toolNudgeSent = true;
          log('nudge: model produced text without calling write_file — requesting tool calls');
          messages.push({ role: 'assistant', content: content || '' });
          messages.push({
            role: 'user',
            content: 'You described file contents but did not call write_file(). ' +
              'Now call write_file() for EACH file you described. ' +
              'Do NOT repeat the file contents as text — call write_file() directly for each one.',
          });
          continue;
        }
        log(`completed in ${turn} turn(s), ${Math.floor((Date.now() - startTs) / 1000)}s`);
        break;
      }

      // Add assistant message (with tool calls)
      messages.push({
        role: 'assistant',
        content: content || '',
        tool_calls,
      });

      // Execute tool calls and collect results
      for (const tc of tool_calls) {
        const fnName = tc.function?.name;
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          fnArgs = {};
        }

        log(`tool: ${fnName}(${JSON.stringify(fnArgs).slice(0, 100)})`);
        if (fnName === 'write_file') writeFileCalled = true;

        const executor = TOOL_EXECUTORS[fnName];
        let result;
        if (!executor) {
          result = `Unknown tool: ${fnName}`;
        } else {
          try {
            result = await executor(fnArgs, toolCtx);
          } catch (err) {
            result = `Tool error: ${err.message}`;
          }
        }

        if (typeof result === 'string' && result.length > 20000) {
          result = result.slice(0, 20000) + '\n...(truncated)';
        }

        const safeResult = sanitizeToolResult(result);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof safeResult === 'string'
            ? safeResult
            : (JSON.stringify(safeResult) ?? 'null'),
        });
      }
    }

    if (turn >= MAX_TURNS) {
      log(`WARNING: reached max turns (${MAX_TURNS}) — stopping`);
      exitCode = 1;
    }
  } catch (err) {
    log(`ERROR: unexpected: ${err.message}`);
    exitCode = 1;
  } finally {
    if (browser) {
      try { browser.disconnect(); } catch {}
    }
  }

  // Auto-save: parse model text output for files the model described but didn't write via tools
  if (agent === 'x-hunter' && !writeFileCalled && allText.length > 200) {
    // 1. Save state files from markdown code blocks: #### state/path.ext\n```lang\ncontent\n```
    const stateBlockRe = /####\s+state\/([^\n]+)\n```[^\n]*\n([\s\S]*?)```/g;
    let stateMatch;
    while ((stateMatch = stateBlockRe.exec(allText)) !== null) {
      const relPath = 'state/' + stateMatch[1].trim();
      const content = stateMatch[2];
      const fullPath = path.join(config.PROJECT_ROOT, relPath);
      try {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        log('auto-saved from text: ' + relPath);
      } catch (e) {
        log('WARNING: auto-save failed for ' + relPath + ': ' + e.message);
      }
    }

    // 2. Save journal — look for expected path in the prompt message, then extract content
    const jPathMatch = message && message.match(/journals\/((\d{4}-\d{2}-\d{2})_(\d{2}))\.html/);
    if (jPathMatch) {
      const jSlug = jPathMatch[1]; // e.g. "2026-05-27_12"
      const jDate = jPathMatch[2];
      const jHour = jPathMatch[3];
      const jPath = path.join(config.JOURNALS_DIR, jSlug + '.html');
      if (!fs.existsSync(jPath)) {
        let journalContent = null;

        // Try <article class="journal-entry">...</article>
        const artMatch = allText.match(/<article[^>]*>[\s\S]*?<\/article>/i);
        if (artMatch) journalContent = artMatch[0];

        // Try markdown journal section: ### Journal for Day X
        if (!journalContent) {
          const mdMatch = allText.match(/###\s+Journal(?:\s+(?:for|entry)[^\n]*)?\n([\s\S]+?)(?=\n###|\n---|\n\*\*\*|$)/i);
          if (mdMatch && mdMatch[1].length > 100) {
            const dayMatch = allText.match(/Day\s+(\d+)/i);
            const dayNum = dayMatch ? dayMatch[1] : '?';
            const bodyHtml = mdMatch[1]
              .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
              .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
              .replace(/^\[([^\]]+)\]\s+-.*$/gm, '<li>$1</li>')
              .replace(/^-\s+(.+)$/gm, '<li>$1</li>')
              .replace(/\n{2,}/g, '</p><p>')
              .trim();
            journalContent =
              '<article class="journal-entry">\n' +
              '  <header><h2>Day ' + dayNum + ' · Hour ' + jHour + '</h2></header>\n' +
              '  <section class="stream"><p>' + bodyHtml + '</p></section>\n' +
              '</article>';
          }
        }

        if (journalContent) {
          const dayMatch = allText.match(/Day\s+(\d+)/i);
          const dayNum = dayMatch ? dayMatch[1] : '?';
          const html = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '  <meta charset="UTF-8">',
            '  <meta name="x-hunter-date" content="' + jDate + '">',
            '  <meta name="x-hunter-hour" content="' + jHour + '">',
            '  <meta name="x-hunter-day" content="' + dayNum + '">',
            '  <title>Journal — ' + jDate + ' ' + jHour + ':00</title>',
            '</head>',
            '<body>',
            journalContent,
            '</body>',
            '</html>',
          ].join('\n');
          try {
            fs.mkdirSync(path.dirname(jPath), { recursive: true });
            fs.writeFileSync(jPath, html);
            log('auto-saved journal from text output: ' + jPath);
          } catch (writeErr) {
            log('WARNING: auto-save journal failed: ' + writeErr.message);
          }
        }
      }
    }
  } else if (agent === 'x-hunter' && !writeFileCalled && allText.includes('<article class="journal-entry">')) {
    // Legacy fallback: HTML article in text
    const now = new Date();
    const jToday = now.toISOString().slice(0, 10);
    const jHour = String(now.getUTCHours()).padStart(2, '0');
    const jPath = path.join(config.JOURNALS_DIR, jToday + '_' + jHour + '.html');
    if (!fs.existsSync(jPath)) {
      const artMatch = allText.match(/<article class="journal-entry">[\s\S]*?<\/article>/);
      if (artMatch) {
        const dayMatch = allText.match(/Day (\d+)/);
        const dayNum = dayMatch ? dayMatch[1] : '?';
        const html = [
          '<!DOCTYPE html>', '<html lang="en">', '<head>',
          '  <meta charset="UTF-8">',
          '  <meta name="x-hunter-date" content="' + jToday + '">',
          '  <meta name="x-hunter-hour" content="' + jHour + '">',
          '  <meta name="x-hunter-day" content="' + dayNum + '">',
          '  <title>Journal — ' + jToday + ' ' + jHour + ':00</title>',
          '</head>', '<body>', artMatch[0], '</body>', '</html>',
        ].join('\n');
        try {
          fs.writeFileSync(jPath, html);
          log('auto-saved journal from text output: ' + jPath);
        } catch (writeErr) {
          log('WARNING: auto-save journal failed: ' + writeErr.message);
        }
      }
    }
  }

  const elapsed = Math.floor((Date.now() - startTs) / 1000);
  log(`agent=${agent} exit=${exitCode} elapsed=${elapsed}s turns=${turn}`);
  return exitCode;
}

// ── Sync wrapper ──────────────────────────────────────────────────────────────

function agentRunSync({ agent, message, thinking, verbose, model }) {
  const { execFileSync } = require('child_process');

  const tmpPrompt = path.join(config.STATE_DIR, '.agent_prompt.tmp');
  fs.writeFileSync(tmpPrompt, message);

  const args = [
    path.join(__dirname, 'gemini_agent_runner.js'),
    '--agent', agent,
    '--prompt-file', tmpPrompt,
  ];
  if (thinking) args.push('--thinking', thinking);
  if (verbose) args.push('--verbose', verbose);
  if (model) args.push('--model', model);

  try {
    execFileSync('node', args, {
      stdio: 'inherit',
      env: process.env,
      timeout: MAX_TIMEOUT_MS + 30_000,
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
