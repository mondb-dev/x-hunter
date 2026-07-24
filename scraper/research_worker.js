#!/usr/bin/env node
/**
 * scraper/research_worker.js — detached deep-research worker for X mentions.
 *
 * reply.js spawns this (unref'd, stdio ignored) when X_ASYNC_RESEARCH=1 and a
 * mention needs research, instead of blocking the reply loop for minutes. We
 * run researchAndPublish() here and drop the result as JSON at
 *   state/research_results/<mention_id>.json
 * A later reply.js run reads that file and posts the reply through the normal
 * outbound gate + posting tail. On failure we still write a result (with
 * `error`) so the pickup can fall back to a plain draft rather than wait out
 * the 6h TTL.
 *
 * Env: RESEARCH_ITEM_ID (mention id), RESEARCH_QUERY (question).
 */

"use strict";

const fs   = require("fs");
const path = require("path");

try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const ROOT         = path.resolve(__dirname, "..");
const RESEARCH_DIR = path.join(ROOT, "state", "research_results");

(async () => {
  const id    = process.env.RESEARCH_ITEM_ID;
  const query = process.env.RESEARCH_QUERY;
  if (!id || !query) {
    console.error("[research_worker] missing RESEARCH_ITEM_ID / RESEARCH_QUERY");
    process.exit(1);
  }

  fs.mkdirSync(RESEARCH_DIR, { recursive: true });
  const outPath = path.join(RESEARCH_DIR, `${id}.json`);
  const write = (obj) => {
    try {
      fs.writeFileSync(outPath, JSON.stringify({ ...obj, done_at: new Date().toISOString() }, null, 2));
    } catch (e) {
      console.error(`[research_worker] could not write result: ${e.message}`);
    }
  };

  console.log(`[research_worker] researching (id=${id}): "${query.slice(0, 90)}"`);
  try {
    const { researchAndPublish } = require("../runner/deep_research");
    const rr = await researchAndPublish(query, { maxFetch: 3, source: "x_mention" });
    write({
      ready:       true,
      shortAnswer: rr.shortAnswer || "",
      url:         rr.url || null,
      bailed:      !!rr.bailed,
      confidence:  rr.confidence ?? null,
    });
    console.log(`[research_worker] done → ${rr.url || (rr.bailed ? "(clarify)" : "(no report)")}`);
  } catch (e) {
    write({ ready: true, error: e.message, shortAnswer: "", url: null, bailed: false });
    console.error(`[research_worker] research failed: ${e.message}`);
  }
  process.exit(0);
})();
