'use strict';

/**
 * runner/openai_caller.js — shared OpenAI Chat Completions caller
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

module.exports = { callOpenAI };
