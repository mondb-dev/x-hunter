/**
 * GCS helpers for Cloud Run data reads.
 *
 * When running in Cloud Run (K_SERVICE env set), reads go directly to the GCS
 * bucket via the Storage API — no FUSE caching, always fresh.
 *
 * In local dev (K_SERVICE not set), falls back to local fs so nothing changes.
 */

import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

export const IS_CLOUD_RUN = !!process.env.K_SERVICE;
const BUCKET = process.env.GCS_DATA_BUCKET || "sebastian-hunter-data";

let _storage: Storage | null = null;
function getStorage(): Storage {
  if (!_storage) _storage = new Storage();
  return _storage;
}

/**
 * List files directly in `prefix/` directory matching `pattern`.
 * Returns filenames only (no path prefix).
 */
export async function gcsListFiles(prefix: string, pattern: RegExp): Promise<string[]> {
  if (!IS_CLOUD_RUN) {
    const dir = path.join(DATA_ROOT, prefix);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => pattern.test(f)).sort();
  }
  try {
    const [files] = await getStorage().bucket(BUCKET).getFiles({ prefix: `${prefix}/` });
    return files
      .map((f) => path.basename(f.name))
      .filter((f) => pattern.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read a file from GCS (relPath relative to bucket root, e.g. "articles/foo.md").
 * In local dev, reads from DATA_ROOT.
 */
export async function gcsReadFile(relPath: string): Promise<string> {
  if (!IS_CLOUD_RUN) {
    return fs.readFileSync(path.join(DATA_ROOT, relPath), "utf-8");
  }
  const [buf] = await getStorage().bucket(BUCKET).file(relPath).download();
  return buf.toString("utf-8");
}

/**
 * Read a file from GCS as a raw Buffer (for binary files like images).
 */
export async function gcsReadBuffer(relPath: string): Promise<Buffer> {
  if (!IS_CLOUD_RUN) {
    return fs.readFileSync(path.join(DATA_ROOT, relPath));
  }
  const [buf] = await getStorage().bucket(BUCKET).file(relPath).download();
  return buf;
}

/**
 * Check if a file exists in GCS.
 * In local dev, uses fs.existsSync.
 */
export async function gcsFileExists(relPath: string): Promise<boolean> {
  if (!IS_CLOUD_RUN) {
    return fs.existsSync(path.join(DATA_ROOT, relPath));
  }
  try {
    const [exists] = await getStorage().bucket(BUCKET).file(relPath).exists();
    return exists;
  } catch {
    return false;
  }
}
