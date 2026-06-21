'use strict';

/**
 * runner/openai_caller.js — shared OpenAI caller
 *
 * callOpenAI()       — Chat Completions (/v1/chat/completions)
 * callOpenAISearch() — Responses API (/v1/responses) with web_search_preview
 *
 * Used by write_article.js, proactive_reply.js, scraper/reply.js.
 * Reads OPEN_AI_API_KEY from env (matches .env convention).
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const OPENAI_BASE = process.env.OLLAMA_BASE_URL || 'https://api.openai.com';
const API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_AI_API_KEY || '';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gpt-5';

/**
 * callOpenAI({ prompt, systemPrompt, model, maxTokens, temperature })
 * Standard Chat Completions — no web search.
 * Returns the response text string.
 */
async function callOpenAI({ prompt, systemPrompt, model, maxTokens = 4096, temperature = 0.7 } = {}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const resolvedModel = model || DEFAULT_MODEL;
  // gpt-5 and gpt-5.5 only support temperature=1 (the default); omit the param for those models
  const supportsTemperature = !/^gpt-5/.test(resolvedModel);
  const body = {
    model: resolvedModel,
    messages,
    max_completion_tokens: maxTokens,
    ...(supportsTemperature ? { temperature } : {}),
  };

  const MAX_RETRIES = 3;
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000); // 3 min

    try {
      const res = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      clearTimeout(timer);

      if (res.status === 429) {
        const errBody = await res.text().catch(() => '');
        const waitMatch = errBody.match(/try again in ([\d.]+)s/i);
        const waitMs = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 1000 : (attempt + 1) * 8000;
        lastErr = new Error(`OpenAI 429: ${errBody.slice(0, 200)}`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, waitMs)); continue; }
        throw lastErr;
      }

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${err.slice(0, 300)}`);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (!text) throw new Error(`OpenAI returned empty response`);
      return text.trim();
    } catch (err) {
      clearTimeout(timer);
      // Retry on network errors (socket hang up, ECONNRESET, abort)
      const isRetryable = err.name === 'AbortError' ||
        /socket hang up|ECONNRESET|ECONNREFUSED|fetch failed/i.test(err.message);
      if (isRetryable && attempt < MAX_RETRIES) {
        const waitMs = (attempt + 1) * 5000;
        console.error(`[openai] attempt ${attempt + 1} failed (${err.message}) — retrying in ${waitMs}ms`);
        lastErr = err;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}

/**
 * callOpenAISearch({ prompt, systemPrompt, model, maxTokens })
 * Responses API with web_search_preview — has live web search.
 * Returns { text, sourceUrls }.
 */
async function callOpenAISearch({ prompt, systemPrompt, model, maxTokens = 4096 } = {}) {
  const input = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

  const body = {
    model: model || DEFAULT_MODEL,
    input,
    tools: [{ type: 'web_search_preview' }],
    max_output_tokens: maxTokens,
  };

  const res = await fetch(`${OPENAI_BASE}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OpenAI Responses ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();

  // Extract text from output items
  const textParts = (data.output || [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text);

  const text = textParts.join('').trim();
  if (!text) throw new Error(`OpenAI Responses returned empty output`);

  // Extract cited URLs from annotations
  const sourceUrls = (data.output || [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(c => c.type === 'output_text')
    .flatMap(c => c.annotations || [])
    .filter(a => a.type === 'url_citation' && a.url)
    .map(a => a.url)
    .filter((u, i, arr) => arr.indexOf(u) === i) // dedupe
    .slice(0, 5);

  return { text, sourceUrls };
}

module.exports = { callOpenAI, callOpenAISearch };
