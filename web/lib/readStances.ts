import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

export interface StanceGrounding {
  axis_id: string;
  pole: "left" | "right";
}

export interface Stance {
  id: string;
  event: string;
  question: string;
  side: string;
  type: "principled" | "taste";
  pole_a?: string;
  pole_b?: string;
  position?: number | null;
  grounded_in: StanceGrounding[];
  confidence_pct: number;
  rationale?: string;
  resolves_when?: string;
  research?: { confidence_pct?: number | null; key_finding?: string } | null;
  taken_at?: string;
  status: "open" | "resolved" | "abandoned";
  outcome?: string | null;
  was_right?: boolean | null;
  resolved_at?: string | null;
}

export function readStances(): Stance[] {
  try {
    const raw = fs.readFileSync(path.join(DATA_ROOT, "state", "stances.json"), "utf-8");
    const j = JSON.parse(raw);
    return Array.isArray(j?.stances) ? j.stances : [];
  } catch {
    return [];
  }
}
