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

  const body = {
    model: model || DEFAULT_MODEL,
    messages,
    max_completion_tokens: maxTokens,
    temperature,
  };

  const res = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`OpenAI returned empty response`);
  return text.trim();
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
