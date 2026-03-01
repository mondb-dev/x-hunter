import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DATA_ROOT } from "@/lib/dataRoot";

export function GET() {
  const cwd = process.cwd();

  function probe(p: string) {
    return {
      exists: fs.existsSync(p),
      files: fs.existsSync(p) ? fs.readdirSync(p).slice(0, 3) : [],
    };
  }

  return NextResponse.json({
    cwd,
    DATA_ROOT,
    // Where do journals actually live?
    "cwd/journals":           probe(path.join(cwd, "journals")),
    "cwd/data/journals":      probe(path.join(cwd, "data", "journals")),
    "cwd/../journals":        probe(path.resolve(cwd, "..", "journals")),
    "cwd/../data/journals":   probe(path.resolve(cwd, "..", "data", "journals")),
    "DATA_ROOT/journals":     probe(path.join(DATA_ROOT, "journals")),
    "DATA_ROOT/state":        probe(path.join(DATA_ROOT, "state")),
  });
}
