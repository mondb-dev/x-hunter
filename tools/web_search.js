'use strict';

const name = 'web_search';
const description = 'Search the web using Google Search grounding via Vertex AI. Returns a summary with sources.';

const capabilities = {
  read: [],
  write: [],
  network: true,
};

async function execute({ query }) {
  if (!query) return { error: 'query is required' };

  const { getAccessToken, getProjectConfig } = require('../runner/gcp_auth');
  const token = await getAccessToken();
  const { project, location } = getProjectConfig();
  const model = 'gemini-2.5-flash';
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');

    const grounding = data?.candidates?.[0]?.groundingMetadata;
    let sources = [];
    if (grounding?.groundingChunks) {
      sources = grounding.groundingChunks
        .filter(c => c.web)
        .map(c => ({ title: c.web.title || 'Untitled', url: c.web.uri }));
    }

    return { text: text || 'No results found.', sources };
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'web_search timed out (30s)' };
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { name, description, capabilities, execute };
