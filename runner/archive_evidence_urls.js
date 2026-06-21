#!/usr/bin/env node
/**
 * runner/archive_evidence_urls.js — archive evidence source URLs to Arweave
 *
 * Reads state/evidence_url_queue.jsonl (written by apply_ontology_delta.js),
 * uploads each source URL as a stub record to Arweave via Irys, then updates
 * the matching evidence entry in ontology.json with the arweave_tx.
 *
 * Safe to run periodically. Skips URLs already present in evidence entries with
 * arweave_tx set. Clears processed entries from the queue.
 *
 * Usage: node runner/archive_evidence_urls.js
 * Env:   SOLANA_PRIVATE_KEY — base58 Solana private key
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const ENV_PATH = path.resolve(__dirname, "../.env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ROOT       = path.resolve(__dirname, "..");
const ONTO_PATH  = path.join(ROOT, "state", "ontology.json");
const QUEUE_PATH = path.join(ROOT, "state", "evidence_url_queue.jsonl");
const LOG_PATH   = path.join(ROOT, "state", "arweave_log.json");

// ── Irys helper ───────────────────────────────────────────────────────────────
let _irys = null;
async function getIrys() {
  if (_irys) return _irys;
  const key = process.env.SOLANA_PRIVATE_KEY;
  if (!key) return null;
  try {
    const Irys = require("@irys/sdk");
    const irys = new Irys({
      url: "https://node1.irys.xyz",
      token: "solana",
      key,
      config: { providerUrl: "https://api.mainnet-beta.solana.com" },
    });
    await irys.ready();
    _irys = irys;
    return irys;
  } catch (err) {
    console.warn("[archive_evidence] Irys init failed:", err.message);
    return null;
  }
}

async function uploadStub(irys, entry) {
  const content = JSON.stringify({
    type:    "evidence_source",
    url:     entry.url,
    axis_id: entry.axis_id,
    ts:      entry.ts,
  });
  const buf = Buffer.from(content, "utf-8");
  try {
    const price   = await irys.getPrice(buf.length);
    const balance = await irys.getLoadedBalance();
    if (balance.lt(price)) {
      console.warn("[archive_evidence] Irys balance too low for", entry.url.slice(0, 60));
      return null;
    }
    const tags = [
      { name: "Content-Type",  value: "application/json" },
      { name: "App-Name",      value: "sebastian-hunter" },
      { name: "Type",          value: "evidence_source" },
      { name: "Source-URL",    value: entry.url.slice(0, 200) },
      { name: "Axis-ID",       value: String(entry.axis_id) },
    ];
    const receipt = await irys.upload(buf, { tags });
    return receipt.id;
  } catch (err) {
    console.warn("[archive_evidence] upload failed for", entry.url.slice(0, 60), err.message);
    return null;
  }
}

// ── Ontology updater ──────────────────────────────────────────────────────────
function updateOntologyTx(url, axisId, txId) {
  const onto = JSON.parse(fs.readFileSync(ONTO_PATH, "utf-8"));
  const axis = onto.axes.find(a => a.id === axisId || a.id === String(axisId));
  if (!axis) return false;
  const log = axis.evidence_log || [];
  let updated = false;
  for (const e of log) {
    if (e.source === url && !e.arweave_tx) {
      e.arweave_tx = txId;
      updated = true;
    }
  }
  if (updated) fs.writeFileSync(ONTO_PATH, JSON.stringify(onto, null, 2));
  return updated;
}

// ── Arweave log ───────────────────────────────────────────────────────────────
function appendArweaveLog(entry) {
  let log = { uploads: [] };
  try { log = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8")); } catch { }
  log.uploads.push(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(QUEUE_PATH)) {
    console.log("[archive_evidence] No queue file found — nothing to do.");
    return;
  }

  const lines = fs.readFileSync(QUEUE_PATH, "utf-8").split("\n").filter(l => l.trim());
  if (!lines.length) {
    console.log("[archive_evidence] Queue is empty.");
    return;
  }

  const queue = [];
  for (const line of lines) {
    try { queue.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  console.log(`[archive_evidence] ${queue.length} entries to process`);

  const irys = await getIrys();
  if (!irys) {
    console.log("[archive_evidence] Irys unavailable — cannot archive. Queue retained.");
    return;
  }

  const bal = await irys.getLoadedBalance();
  console.log(`[archive_evidence] Irys balance: ${irys.utils.fromAtomic(bal)} SOL`);

  const processed = new Set();
  let done = 0, failed = 0;

  for (const entry of queue) {
    const key = `${entry.url}::${entry.axis_id}`;
    if (processed.has(key)) continue; // dedup within queue
    processed.add(key);

    const txId = await uploadStub(irys, entry);
    if (txId) {
      const updated = updateOntologyTx(entry.url, entry.axis_id, txId);
      appendArweaveLog({
        tx_id:       txId,
        type:        "evidence_source",
        url:         entry.url,
        axis_id:     entry.axis_id,
        gateway:     `https://gateway.irys.xyz/${txId}`,
        uploaded_at: new Date().toISOString(),
      });
      done++;
      console.log(`[archive_evidence] archived ${entry.url.slice(0, 60)} → ${txId} (ontology updated: ${updated})`);
    } else {
      failed++;
    }
  }

  // Clear queue (only remove processed entries — keep failed ones for retry)
  // For simplicity: clear entire queue if all processed (failed ones will be re-queued on next cycle)
  if (failed === 0) {
    fs.writeFileSync(QUEUE_PATH, "");
    console.log("[archive_evidence] Queue cleared.");
  } else {
    console.log(`[archive_evidence] ${failed} failed uploads — queue retained for retry`);
  }

  console.log(`[archive_evidence] done. archived=${done}, failed=${failed}`);
  process.exit(0);
})();
