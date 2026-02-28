#!/usr/bin/env node
/**
 * runner/backfill_embeddings.js — generate embeddings for unembedded memory + posts
 *
 * Embeds every memory entry and every post that does not yet have a stored
 * embedding vector. Runs once; safe to re-run (idempotent — skips already-embedded).
 *
 * Usage:
 *   node runner/backfill_embeddings.js
 *   node runner/backfill_embeddings.js --posts     (posts only)
 *   node runner/backfill_embeddings.js --memory    (memory only)
 *   node runner/backfill_embeddings.js --batch 50  (set batch size, default 20)
 *
 * Entity types stored: 'memory' (memory.id), 'post' (posts.id)
 *
 * Ollama must be running with nomic-embed-text pulled.
 * Pull with: ollama pull nomic-embed-text
 */

"use strict";

const db    = require("../scraper/db");
const { embed } = require("../scraper/embed");

// ── Args ──────────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const doMemory    = !args.includes("--posts");
const doPosts     = !args.includes("--memory");
const batchIdx    = args.indexOf("--batch");
const BATCH_SIZE  = batchIdx !== -1 ? parseInt(args[batchIdx + 1], 10) || 20 : 20;
const DELAY_MS    = 150; // gentle rate-limiting between Ollama calls

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Embed a batch of {id, text} rows for a given entity type ──────────────────
async function embedBatch(entityType, rows) {
  let done = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const text = (row.text_content || row.text || "").trim();
    if (!text) { skipped++; continue; }

    const vec = await embed(text);
    if (!vec) {
      failed++;
      process.stdout.write("x");
    } else {
      db.storeEmbedding(entityType, String(row.id), vec);
      done++;
      process.stdout.write(".");
    }

    await sleep(DELAY_MS);
  }

  process.stdout.write("\n");
  return { done, skipped, failed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const _db = db.raw();

  // ── Memory ──────────────────────────────────────────────────────────────────
  if (doMemory) {
    const existingIds = db.embeddedIds("memory");
    const allMemory   = _db.prepare("SELECT id, text_content FROM memory ORDER BY id").all();
    const pending     = allMemory.filter(r => !existingIds.has(String(r.id)));

    console.log(`[backfill] memory: ${allMemory.length} total, ${existingIds.size} already embedded, ${pending.length} to embed`);

    if (pending.length > 0) {
      let total = { done: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)}: `);
        const r = await embedBatch("memory", batch);
        total.done    += r.done;
        total.skipped += r.skipped;
        total.failed  += r.failed;
      }
      console.log(`[backfill] memory done — embedded: ${total.done}, skipped: ${total.skipped}, failed: ${total.failed}`);
    }
  }

  // ── Posts ────────────────────────────────────────────────────────────────────
  if (doPosts) {
    const existingIds = db.embeddedIds("post");
    const allPosts    = _db.prepare("SELECT id, text FROM posts ORDER BY ts DESC").all();
    const pending     = allPosts.filter(r => !existingIds.has(String(r.id)));

    console.log(`[backfill] posts: ${allPosts.length} total, ${existingIds.size} already embedded, ${pending.length} to embed`);

    if (pending.length > 0) {
      let total = { done: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)}: `);
        const r = await embedBatch("post", batch);
        total.done    += r.done;
        total.skipped += r.skipped;
        total.failed  += r.failed;
      }
      console.log(`[backfill] posts done — embedded: ${total.done}, skipped: ${total.skipped}, failed: ${total.failed}`);
    }
  }

  console.log("[backfill] complete");
  process.exit(0);
})().catch(err => {
  console.error(`[backfill] fatal: ${err.message}`);
  process.exit(1);
});
