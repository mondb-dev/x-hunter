import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SprintTask {
  id: number;
  title: string;
  status: string;
  type: string;
}

export interface SprintWeek {
  week: number;
  goal: string;
  status: string;
  tasks_total: number;
  tasks_done: number;
}

export interface Accomplishment {
  date: string;
  description: string;
  evidence: string | null;
  impact: string | null;
}

export interface SprintSnapshot {
  plan_id: string;
  plan_title: string;
  plan_status: string;
  activated: string;
  target_end: string | null;
  brief: string;
  compulsion: string;
  success_30d: string;
  belief_axes: string[];
  total_sprints: number;
  current_week: number | null;
  current_goal: string | null;
  current_tasks: SprintTask[];
  sprints: SprintWeek[];
  accomplishments: Accomplishment[];
  snapshot_at: string;
}

export interface ActivePlan {
  id: string;
  title: string;
  compulsion: string;
  brief: string;
  success_30d: string;
  belief_axes: string[];
  status: string;
  activated_date: string;
  research?: {
    milestones?: Array<{ week: number; goal: string }>;
    risks?: string[];
    open_questions?: string[];
  };
}

// ── Readers ───────────────────────────────────────────────────────────────────

const SNAPSHOT_PATH = path.join(DATA_ROOT, "state/sprint_snapshot.json");
const PLAN_PATH = path.join(DATA_ROOT, "state/active_plan.json");

const EMPTY_SNAPSHOT: SprintSnapshot = {
  plan_id: "",
  plan_title: "",
  plan_status: "none",
  activated: "",
  target_end: null,
  brief: "",
  compulsion: "",
  success_30d: "",
  belief_axes: [],
  total_sprints: 0,
  current_week: null,
  current_goal: null,
  current_tasks: [],
  sprints: [],
  accomplishments: [],
  snapshot_at: "",
};

export function readSprintSnapshot(): SprintSnapshot {
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, "utf-8");
    if (!raw.trim()) return EMPTY_SNAPSHOT;
    return JSON.parse(raw) as SprintSnapshot;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

export function readActivePlan(): ActivePlan | null {
  try {
    const raw = fs.readFileSync(PLAN_PATH, "utf-8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as ActivePlan;
  } catch {
    return null;
  }
}
