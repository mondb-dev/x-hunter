/**
 * In-memory TTL cache for GCS FUSE filesystem reads.
 *
 * Why: every fs.readFileSync / readdirSync call via the GCS FUSE mount
 * makes a network roundtrip to Cloud Storage (~20–200 ms each). Pages and
 * the /api/ask handler do 50–100 such calls per request.
 *
 * How it stays in sync:
 *   - syncToGCS() on the VM writes state/sync_version.txt (a unix timestamp)
 *     before rsyncing data to the bucket.
 *   - Every VERSION_TTL ms (15 s) we re-read that one lightweight file.
 *   - If the version changed → clear all cached entries immediately.
 *   - FILE_TTL (60 s) is a belt-and-suspenders expiry in case the version
 *     file is temporarily unreadable.
 *
 * Usage:
 *   import { cachedReadFileSync, cachedReaddirSync } from "./fileCache";
 *   // relPath is relative to DATA_ROOT, e.g. "state/ontology.json"
 *   const raw = cachedReadFileSync("state/ontology.json");
 *   const files = cachedReaddirSync("journals");
 */

import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

const VERSION_TTL = 15_000; // ms — how often to re-check sync_version.txt
const FILE_TTL    = 60_000; // ms — max age for any cached entry

interface Entry<T> { value: T; ts: number }

const fileEntries = new Map<string, Entry<string>>();
const dirEntries  = new Map<string, Entry<string[]>>();

let versionEntry: Entry<string> | null = null;
let knownVersion: string | null = null;

function readVersionStamp(): string {
  try {
    const p = path.join(DATA_ROOT, "state", "sync_version.txt");
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Re-read the version stamp at most once per VERSION_TTL.
 * If it changed, flush all cached file and dir entries.
 */
function refreshVersion(): void {
  const now = Date.now();
  if (versionEntry && now - versionEntry.ts < VERSION_TTL) return;

  const v = readVersionStamp();
  versionEntry = { value: v, ts: now };

  if (knownVersion !== null && v !== knownVersion) {
    fileEntries.clear();
    dirEntries.clear();
  }
  knownVersion = v;
}

/**
 * Cached equivalent of fs.readFileSync(path.join(DATA_ROOT, relPath), "utf-8").
 * Throws if the file does not exist (same as readFileSync).
 */
export function cachedReadFileSync(relPath: string): string {
  refreshVersion();
  const now = Date.now();
  const hit = fileEntries.get(relPath);
  if (hit && now - hit.ts < FILE_TTL) return hit.value;

  const value = fs.readFileSync(path.join(DATA_ROOT, relPath), "utf-8");
  fileEntries.set(relPath, { value, ts: now });
  return value;
}

/**
 * Cached equivalent of fs.readdirSync(path.join(DATA_ROOT, relPath)).
 * Returns [] if the directory does not exist.
 */
export function cachedReaddirSync(relPath: string): string[] {
  refreshVersion();
  const now = Date.now();
  const hit = dirEntries.get(relPath);
  if (hit && now - hit.ts < FILE_TTL) return hit.value;

  const dir = path.join(DATA_ROOT, relPath);
  const value = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  dirEntries.set(relPath, { value, ts: now });
  return value;
}
