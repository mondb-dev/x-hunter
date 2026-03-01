import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DATA_ROOT } from "@/lib/dataRoot";

export function GET() {
  const cwd = process.cwd();
  const journalsDir = path.join(DATA_ROOT, "journals");
  const stateDir = path.join(DATA_ROOT, "state");

  return NextResponse.json({
    cwd,
    DATA_ROOT,
    journalsDirExists: fs.existsSync(journalsDir),
    stateDirExists: fs.existsSync(stateDir),
    journalsFiles: fs.existsSync(journalsDir) ? fs.readdirSync(journalsDir).slice(0, 5) : [],
    stateFiles: fs.existsSync(stateDir) ? fs.readdirSync(stateDir).slice(0, 5) : [],
  });
}
