#!/usr/bin/env node
/**
 * runner/local_llm.js — local (Ollama) LLM + embedding helpers for the
 * non-agent callers that historically went through Vertex (vertex.js / llm.js).
 *
 * Single switch: if OLLAMA_BASE_URL points at a local Ollama (localhost /
 * 127.0.0.1), useLocal() is true and callVertex/llm.generate/llm.embed route
 * here instead of Vertex. Flip OLLAMA_BASE_URL back to the aiplatform URL to
 * revert the entire non-agent brain to Gemini — no caller changes either way.
 *
 * Models (override via .env):
 *   LOCAL_CHAT_MODEL   (default: qwen2.5-agent)     — text generation
 *   LOCAL_EMBED_MODEL  (default: nomic-embed-text)  — 768-dim embeddings
 *
 * No external deps — Node built-in fetch.
 */

'use strict';

const BASE = () => process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const CHAT_MODEL  = () => process.env.LOCAL_CHAT_MODEL  || 'qwen2.5-agent';
const EMBED_MODEL = () => process.env.LOCAL_EMBED_MODEL || 'nomic-embed-text';

/** True when we should route to a local Ollama instead of Vertex. */
function useLocal() {
  const u = process.env.OLLAMA_BASE_URL || '';
  return u.includes('localhost') || u.includes('127.0.0.1');
}

/**
 * localChat(prompt, opts) → Promise<string>
 * OpenAI-compatible single-turn completion against Ollama.
 * opts.maxTokens, opts.temperature, opts.timeoutMs, opts.model
 */
async function localChat(prompt, opts = {}) {
  const {
    maxTokens   = 2000,
    temperature = 0.7,
    timeoutMs   = 300_000,
    model       = CHAT_MODEL(),
    json        = false,   // when true, constrain output to valid JSON (Ollama grammar)
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        options: { temperature },
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`local LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * localChatJSON(prompt, schema, opts) → Promise<object>
 * Grammar-constrained JSON via Ollama's native /api/chat `format: <schema>`.
 * Guarantees parseable JSON conforming to the schema (no fence/quote breakage).
 */
async function localChatJSON(prompt, schema, opts = {}) {
  const { temperature = 0.4, timeoutMs = 300_000, model = CHAT_MODEL() } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        format: schema,
        options: { temperature },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`local LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.message?.content || '';
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * localEmbed(text) → Promise<number[]|null>
 * 768-dim vector via Ollama /api/embeddings. Never throws (returns null on error).
 */
async function localEmbed(text) {
  if (!text || typeof text !== 'string') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model: EMBED_MODEL(), prompt: text.slice(0, 2048) }),
    });
    if (!res.ok) {
      console.warn(`[local_llm/embed] HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const vec = data?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      console.warn('[local_llm/embed] unexpected response shape');
      return null;
    }
    return vec;
  } catch (err) {
    if (err.name !== 'AbortError') console.warn(`[local_llm/embed] error: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { useLocal, localChat, localChatJSON, localEmbed };
