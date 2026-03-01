import fs from "fs";
import path from "path";

/**
 * Resolve the project data root directory.
 *
 * - Vercel production:       state is bundled into ./data/ by outputFileTracingIncludes
 *                            (prebuild copies state/ + journals/ + checkpoints/ into web/data/)
 *                            Detect: ./data/state exists
 * - Local dev / self-hosted: state lives at ../  (next to web/)
 *                            Detect: ./data/state does not exist
 *
 * Prefer ./data/ over ../ so Vercel always uses the reliably-bundled copy, not the
 * git-repo copy which only appears after a cycle commit.
 */
const bundledState = path.resolve(process.cwd(), "data", "state");
export const DATA_ROOT: string = fs.existsSync(bundledState)
  ? path.resolve(process.cwd(), "data") // Vercel: data/state, data/journals, etc.
  : path.resolve(process.cwd(), ".."); // local dev: ../state, ../journals, etc.
