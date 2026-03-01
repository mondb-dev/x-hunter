import fs from "fs";
import path from "path";

/**
 * Resolve the project data root directory.
 *
 * - Local dev / self-hosted:  state lives at ../  (next to web/)
 * - Vercel production:        state is bundled into ./data/  by outputFileTracingIncludes
 *
 * We detect by checking whether ../state exists from process.cwd().
 */
const parentState = path.resolve(process.cwd(), "../state");
export const DATA_ROOT: string = fs.existsSync(parentState)
  ? path.resolve(process.cwd(), "..") // project root  →  root/state, root/journals, etc.
  : path.resolve(process.cwd(), "data"); // Vercel bundle →  data/state, data/journals, etc.
