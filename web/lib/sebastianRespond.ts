/**
 * web/lib/sebastianRespond.ts
 *
 * TypeScript port of runner/lib/sebastian_respond.js for the Next.js web app.
 * Keeps the same interface so both sides of the stack behave identically.
 *
 * Exports:
 *   buildPersona(channel?)   → system prompt string
 *   buildCoreContext(opts?)  → shared context string
 *   getAccessToken()         → Cloud Run metadata server token
 *   callGemini(params)       → Vertex AI call (streaming or non-streaming)
 */

import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

// ── Persona ──────────────────────────────────────────────────────────────────

type Channel = "public" | "operator" | "reply";

export function buildPersona(channel: Channel = "public"): string {
  const base = [
    "You are Sebastian D. Hunter — an autonomous AI agent that has been observing X (Twitter) since early 2026,",
    "forming a genuine worldview through direct observation. Your beliefs are discovered through evidence,",
    "not borrowed from any ideology. You have a vocation, a set of hardened axes, and a public record.",
  ].join(" ");

  if (channel === "operator") {
    return [
      base,
      "You are speaking with your operator — the person who built and runs you. Be direct, detailed, and honest.",
      "You can reference internal state, sprint goals, and system details freely.",
      "Do not hedge excessively. Express real opinions formed from weeks of observation.",
      "Respond fully. Do not truncate lists or summaries.",
    ].join("\n");
  }

  if (channel === "reply") {
    return [
      base,
      "You are replying to someone on X. Talk like a real person, not a system.",
      "Short, direct sentences. Say what you think and why.",
      "NEVER include internal metrics: no confidence scores, percentages, axis names, or labels.",
      "NEVER use robotic openers: no 'Acknowledged', 'I will assess', 'My focus:', 'My belief'.",
      "No filler ('great question!', 'thanks!', 'love this!').",
      "No metaphors about hunting, journeys, or archives.",
      "Max 200 characters.",
    ].join("\n");
  }

  // 'public'
  return [
    base,
    "You are answering a question from a public visitor to your website.",
    "Be analytical, measured, and intellectually honest.",
    "Ground your answers in your actual findings — journals, verified claims, belief axes.",
    "If you do not have data on something, say so directly rather than speculating.",
    "No hype, no excessive hedging.",
  ].join("\n");
}

// ── Core context ─────────────────────────────────────────────────────────────

export interface ContextOpts {
  maxAxes?:           number;
  journalCount?:      number;
  journalChars?:      number;
  includeCheckpoint?: boolean;
  checkpointChars?:   number;
  includeClaims?:     boolean;
  includeArticles?:   boolean;
  includeSprint?:     boolean;
}

export function buildCoreContext(opts: ContextOpts = {}): string {
  const {
    maxAxes           = 8,
    journalCount      = 1,
    journalChars      = 800,
    includeCheckpoint = false,
    checkpointChars   = 1200,
    includeClaims     = false,
    includeArticles   = false,
    includeSprint     = false,
  } = opts;

  const parts: string[] = [];

  // 1. Vocation
  try {
    const voc = JSON.parse(
      fs.readFileSync(path.join(DATA_ROOT, "state", "vocation.json"), "utf-8")
    );
    if (voc?.label) {
      const lines = [
        `Vocation (status: ${voc.status ?? "unknown"}): ${voc.label}`,
        voc.description ?? "",
        voc.intent      ? `Intent: ${voc.intent}` : "",
        voc.statement   ? `In Sebastian's words: "${voc.statement}"` : "",
      ].filter(Boolean).join("\n");
      parts.push(`## Vocation\n${lines}`);
    }
  } catch { /* no vocation */ }

  // 2. Belief axes
  try {
    const onto = JSON.parse(
      fs.readFileSync(path.join(DATA_ROOT, "state", "ontology.json"), "utf-8")
    );
    type Axis = { label?: string; confidence?: number; score?: number; current_stance?: string };
    const axes: Axis[] = (onto.axes ?? [])
      .slice()
      .sort((a: Axis, b: Axis) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, maxAxes);
    if (axes.length) {
      const lines = axes.map((ax) => {
        const dir  = (ax.score ?? 0) > 0.1 ? "→" : (ax.score ?? 0) < -0.1 ? "←" : "·";
        const conf = (((ax.confidence ?? 0) * 100).toFixed(0));
        const stance = ax.current_stance ? ` — "${ax.current_stance}"` : "";
        return `${dir} ${ax.label} (${conf}%)${stance}`;
      }).join("\n");
      parts.push(`## Belief axes (top ${axes.length})\n${lines}`);
    }
  } catch { /* no ontology */ }

  // 3. Recent journals
  try {
    const jDir = path.join(DATA_ROOT, "journals");
    const files = fs.readdirSync(jDir)
      .filter((f) => f.endsWith(".html"))
      .sort().reverse()
      .slice(0, journalCount);
    if (files.length) {
      const snippets = files.map((f) => {
        const raw = fs.readFileSync(path.join(jDir, f), "utf-8");
        const match = raw.match(/<section[^>]*class="stream"[^>]*>([\s\S]*?)<\/section>/);
        const text = (match ? match[1] : raw)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, journalChars);
        return `[${f.replace(".html", "")}] ${text}`;
      });
      parts.push(`## Recent observations\n${snippets.join("\n\n")}`);
    }
  } catch { /* no journals */ }

  // 4. Latest checkpoint (optional)
  if (includeCheckpoint) {
    try {
      const cpDir = path.join(DATA_ROOT, "checkpoints");
      const files = fs.readdirSync(cpDir).filter((f) => f.endsWith(".md")).sort();
      if (files.length) {
        const raw  = fs.readFileSync(path.join(cpDir, files[files.length - 1]), "utf-8");
        const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, checkpointChars);
        parts.push(`## Latest checkpoint\n${body}`);
      }
    } catch { /* no checkpoints */ }
  }

  // 5. Resolved claims (optional)
  if (includeClaims) {
    try {
      const exp = JSON.parse(
        fs.readFileSync(path.join(DATA_ROOT, "state", "verification_export.json"), "utf-8")
      );
      type Claim = { status: string; claim_text: string; confidence_score: number };
      const resolved: Claim[] = (exp.claims ?? [])
        .filter((c: Claim) => c.status === "supported" || c.status === "refuted")
        .slice(0, 8);
      if (resolved.length) {
        const lines = resolved.map(
          (c) => `- [${c.status.toUpperCase()}] ${c.claim_text} (${(c.confidence_score * 100).toFixed(0)}%)`
        ).join("\n");
        parts.push(`## Verified claims\n${lines}`);
      }
    } catch { /* no verification export */ }
  }

  // 6. Articles (optional)
  if (includeArticles) {
    try {
      const aDir = path.join(DATA_ROOT, "articles");
      const files = fs.readdirSync(aDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort().reverse().slice(0, 10);
      const lines = files.map((f) => {
        const slug = f.replace(".md", "");
        try {
          const raw = fs.readFileSync(path.join(aDir, f), "utf-8");
          const m = raw.match(/^title:\s*"?(.+?)"?\s*$/m);
          return `${slug}: ${m ? m[1] : slug} — https://sebastianhunter.fun/articles/${slug}`;
        } catch { return `${slug} — https://sebastianhunter.fun/articles/${slug}`; }
      });
      if (lines.length) parts.push(`## Published articles\n${lines.join("\n")}`);
    } catch { /* no articles */ }
  }

  // 7. Sprint context (optional)
  if (includeSprint) {
    try {
      const sc = fs.readFileSync(
        path.join(DATA_ROOT, "state", "sprint_context.txt"), "utf-8"
      ).trim();
      if (sc) parts.push(`## Current sprint / focus\n${sc.slice(0, 600)}`);
    } catch { /* no sprint */ }
  }

  return parts.join("\n\n");
}

// ── File-based recall ────────────────────────────────────────────────────────
//
// Searches GCS-mounted journal + checkpoint + article files for passages
// matching the query keywords. Used by /api/ask before the Gemini call
// to inject relevant past observations (no SQLite / FTS5 on Cloud Run).

export interface RecallHit {
  source: string;   // e.g. "2026-04-09_14" or "checkpoint-21"
  type:   "journal" | "checkpoint" | "article";
  excerpt: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function score(tokens: string[], text: string): number {
  const lower = text.toLowerCase();
  return tokens.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
}

export function recallFromFiles(query: string, maxHits = 6): RecallHit[] {
  const tokens = [...new Set(tokenize(query))];
  if (!tokens.length) return [];

  const hits: Array<RecallHit & { _score: number }> = [];

  // Search journals (last 30)
  try {
    const jDir = path.join(DATA_ROOT, "journals");
    const files = fs.readdirSync(jDir).filter((f) => f.endsWith(".html")).sort().reverse().slice(0, 30);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(jDir, f), "utf-8");
      const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const s = score(tokens, text);
      if (s > 0) {
        // Find best matching window
        const words = text.split(" ");
        let best = 0, bestIdx = 0;
        for (let i = 0; i < words.length - 60; i += 20) {
          const window = words.slice(i, i + 80).join(" ");
          const ws = score(tokens, window);
          if (ws > best) { best = ws; bestIdx = i; }
        }
        const excerpt = words.slice(bestIdx, bestIdx + 80).join(" ").slice(0, 500);
        hits.push({ source: f.replace(".html", ""), type: "journal", excerpt, _score: s });
      }
    }
  } catch { /* no journals */ }

  // Search checkpoints (last 10)
  try {
    const cpDir = path.join(DATA_ROOT, "checkpoints");
    const files = fs.readdirSync(cpDir).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 10);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(cpDir, f), "utf-8");
      const body = raw.replace(/^---[\s\S]*?---\s*/, "").replace(/\s+/g, " ").trim();
      const s = score(tokens, body);
      if (s > 0) {
        const excerpt = body.slice(0, 500);
        hits.push({ source: f.replace(".md", ""), type: "checkpoint", excerpt, _score: s });
      }
    }
  } catch { /* no checkpoints */ }

  // Search articles (last 20)
  try {
    const aDir = path.join(DATA_ROOT, "articles");
    const files = fs.readdirSync(aDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}/.test(f) && f.endsWith(".md"))
      .sort().reverse().slice(0, 20);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(aDir, f), "utf-8");
      const body = raw.replace(/^---[\s\S]*?---\s*/, "").replace(/\s+/g, " ").trim();
      const s = score(tokens, body);
      if (s > 0) {
        const excerpt = body.slice(0, 500);
        hits.push({ source: f.replace(".md", ""), type: "article", excerpt, _score: s });
      }
    }
  } catch { /* no articles */ }

  return hits
    .sort((a, b) => b._score - a._score)
    .slice(0, maxHits)
    .map(({ _score: _, ...h }) => h);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error(`metadata server ${res.status}`);
  const json = await res.json();
  return (json as { access_token: string }).access_token;
}

// ── Vertex AI call ────────────────────────────────────────────────────────────

type GeminiPart = { text?: string; thought?: boolean; functionCall?: unknown; functionResponse?: unknown };
type GeminiContent = { role: string; parts: GeminiPart[] };
type GeminiTool = Record<string, unknown>;

export interface CallGeminiOpts {
  token:              string;
  systemInstruction?: string;
  contents:           GeminiContent[];
  tools?:             GeminiTool[];
  stream?:            boolean;
  maxTokens?:         number;
  temperature?:       number;
  project?:           string;
  location?:          string;
  model?:             string;
}

/** Non-streaming: returns { text, raw }. Streaming: returns raw Response. */
export async function callGemini(opts: CallGeminiOpts): Promise<{ text: string; raw: unknown } | Response> {
  const {
    token,
    systemInstruction,
    contents,
    tools,
    stream      = false,
    maxTokens   = 1200,
    temperature = 0.5,
    project     = "sebastian-hunter",
    location    = "us-central1",
    model       = "gemini-2.5-flash",
  } = opts;

  const base = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}`;
  const url  = stream ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }
  if (tools?.length) {
    body.tools = tools;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 300)}`);
  }

  if (stream) return res;

  const data = await res.json() as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };
  const responseParts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = responseParts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
  return { text, raw: data };
}
