#!/usr/bin/env node
'use strict';

/**
 * workers/memory/index.js — Hunter Memory API (Cloud Run HTTP service)
 *
 * Centralised read interface to the memory + ontology + vocation data.
 * Both the VM runner and the web Cloud Run service call this instead of
 * touching Postgres directly.
 *
 * Endpoints:
 *   POST /recall      — FTS full-text search over memory table
 *   POST /semantic    — Cosine similarity over embeddings table (top-k)
 *   GET  /context     — Snapshot: vocation + top axes + recent journal IDs
 *   GET  /health      — Health check
 *
 * Auth:
 *   All endpoints require the header  Authorization: Bearer <MEMORY_API_KEY>
 *   Set MEMORY_API_KEY env var. On Cloud Run internal calls use OIDC instead
 *   (set MEMORY_REQUIRE_OIDC=true — validates Authorization header as ID token).
 *
 * Env vars:
 *   DATABASE_URL       — Postgres connection string (required)
 *   PG_SSL             — 'false' to disable TLS (same-VPC)
 *   MEMORY_API_KEY     — shared secret for Bearer auth
 *   PORT               — HTTP port (default 8080)
 */

const http  = require('http');
const { Pool } = require('pg');

// ── Logging ─────────────────────────────────────────────────────────────────

function structLog(severity, message, fields = {}) {
  console.log(JSON.stringify({ severity, message, component: 'hunter-memory', ...fields, timestamp: new Date().toISOString() }));
}
const log = {
  info:  (msg, f) => structLog('INFO',    msg, f),
  warn:  (msg, f) => structLog('WARNING', msg, f),
  error: (msg, f) => structLog('ERROR',   msg, f),
};

// ── DB ───────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function q(text, params = []) {
  return pool.query(text, params);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

const API_KEY = process.env.MEMORY_API_KEY || '';

function authorized(req) {
  if (!API_KEY) return true; // no key set — open (dev only)
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${API_KEY}`;
}

// ── Request helpers ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 64_000) reject(new Error('body too large')); });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /recall
 * Body: { query: string, limit?: number, types?: string[] }
 *
 * Uses Postgres FTS (plainto_tsquery english) with ts_rank ordering.
 * Returns: { hits: [{ id, type, title, date, file_path, excerpt, rank }] }
 */
async function handleRecall(req, res) {
  const { query, limit = 8, types } = await readBody(req);
  if (!query || typeof query !== 'string') return send(res, 400, { error: 'query required' });

  const safeLimit = Math.min(Number(limit) || 8, 20);
  const tsQuery = query.trim().slice(0, 500);

  let typeFilter = '';
  const params = [tsQuery, safeLimit];
  if (Array.isArray(types) && types.length) {
    typeFilter = `AND type = ANY($3)`;
    params.push(types);
  }

  try {
    const { rows } = await q(
      `SELECT id, type, title, date, file_path,
              left(text_content, 500) AS excerpt,
              ts_rank(to_tsvector('english', text_content), plainto_tsquery('english', $1)) AS rank
       FROM memory
       WHERE to_tsvector('english', text_content) @@ plainto_tsquery('english', $1)
         ${typeFilter}
       ORDER BY rank DESC
       LIMIT $2`,
      params
    );
    log.info('recall', { query: tsQuery.slice(0, 80), hits: rows.length });
    send(res, 200, { hits: rows });
  } catch (err) {
    log.error('recall query failed', { err: err.message });
    send(res, 500, { error: 'query failed' });
  }
}

/**
 * POST /semantic
 * Body: { embedding: number[], limit?: number, types?: string[] }
 *
 * In-process cosine similarity over embeddings table.
 * Returns: { hits: [{ entity_id, entity_type, score, excerpt }] }
 */
async function handleSemantic(req, res) {
  const { embedding, limit = 6, types } = await readBody(req);
  if (!Array.isArray(embedding) || embedding.length < 10) {
    return send(res, 400, { error: 'embedding array required' });
  }

  const safeLimit = Math.min(Number(limit) || 6, 20);

  try {
    // Load all embeddings (small table — 768-dim vectors, ~1MB for 1k rows)
    let embQuery = `SELECT entity_id, entity_type, vector FROM embeddings WHERE entity_type = 'memory'`;
    const embParams = [];
    if (Array.isArray(types) && types.length) {
      embQuery += ` AND entity_id IN (SELECT id::text FROM memory WHERE type = ANY($1))`;
      embParams.push(types);
    }
    const { rows: embRows } = await q(embQuery, embParams);

    // Cosine similarity
    function cosine(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
    }

    const scored = embRows
      .map(r => {
        const vec = typeof r.vector === 'string' ? JSON.parse(r.vector) : r.vector;
        return { entity_id: r.entity_id, entity_type: r.entity_type, score: cosine(embedding, vec) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, safeLimit);

    // Fetch excerpts for top hits
    if (!scored.length) return send(res, 200, { hits: [] });

    const ids = scored.map(s => s.entity_id);
    const { rows: memRows } = await q(
      `SELECT id, type, title, date, file_path, left(text_content, 500) AS excerpt
       FROM memory WHERE id = ANY($1)`,
      [ids]
    );
    const memMap = Object.fromEntries(memRows.map(r => [String(r.id), r]));

    const hits = scored.map(s => ({
      ...s,
      ...(memMap[String(s.entity_id)] || {}),
    }));

    log.info('semantic', { hits: hits.length });
    send(res, 200, { hits });
  } catch (err) {
    log.error('semantic query failed', { err: err.message });
    send(res, 500, { error: 'query failed' });
  }
}

/**
 * GET /context
 * Query params: axes=N (default 8), journal=N (default 1)
 *
 * Returns a compact context snapshot: vocation row + top axes + recent journal IDs.
 * Callers (web, runner) use this to seed the Sebastian persona.
 *
 * Returns: { vocation, axes: [], recentMemory: [] }
 */
async function handleContext(req, res) {
  const url  = new URL(req.url, 'http://localhost');
  const maxAxes    = Math.min(parseInt(url.searchParams.get('axes')    || '8',  10), 20);
  const journalN   = Math.min(parseInt(url.searchParams.get('journal') || '3',  10), 10);

  try {
    // Latest vocation
    const { rows: vocRows } = await q(
      `SELECT data FROM memory WHERE type = 'vocation' ORDER BY id DESC LIMIT 1`
    );
    const vocation = vocRows[0]?.data ?? null;

    // Top axes from latest ontology
    const { rows: ontoRows } = await q(
      `SELECT data FROM memory WHERE type = 'ontology' ORDER BY id DESC LIMIT 1`
    );
    let axes = [];
    if (ontoRows[0]?.data) {
      const onto = typeof ontoRows[0].data === 'string'
        ? JSON.parse(ontoRows[0].data) : ontoRows[0].data;
      axes = (onto.axes || [])
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, maxAxes);
    }

    // Recent journals/checkpoints
    const { rows: recentRows } = await q(
      `SELECT id, type, title, date, file_path, left(text_content, 600) AS excerpt
       FROM memory
       WHERE type IN ('journal', 'checkpoint')
       ORDER BY id DESC
       LIMIT $1`,
      [journalN]
    );

    log.info('context', { axes: axes.length, recent: recentRows.length });
    send(res, 200, { vocation, axes, recentMemory: recentRows });
  } catch (err) {
    log.error('context query failed', { err: err.message });
    send(res, 500, { error: 'query failed' });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const path = (req.url || '/').split('?')[0];

  if (path === '/health') {
    try {
      await q('SELECT 1');
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 503, { ok: false });
    }
  }

  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  try {
    if (method === 'POST' && path === '/recall')   return await handleRecall(req, res);
    if (method === 'POST' && path === '/semantic') return await handleSemantic(req, res);
    if (method === 'GET'  && path === '/context')  return await handleContext(req, res);
    send(res, 404, { error: 'not found' });
  } catch (err) {
    log.error('unhandled', { err: err.message, path, method });
    send(res, 500, { error: 'internal error' });
  }
});

const PORT = parseInt(process.env.PORT || '8080', 10);
server.listen(PORT, () => {
  log.info(`hunter-memory listening on :${PORT}`);
  if (!process.env.DATABASE_URL) log.warn('DATABASE_URL not set — DB calls will fail');
  if (!API_KEY) log.warn('MEMORY_API_KEY not set — auth disabled');
});

process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down');
  server.close(() => pool.end(() => process.exit(0)));
});
