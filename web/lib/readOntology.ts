import fs from "fs";
import path from "path";

export interface EvidenceEntry {
  source: string;
  tweet_id?: string;
  reason: string;
  delta: number;
  quality: number;
}

export interface Axis {
  id: string;
  label: string;
  left_pole: string;
  right_pole: string;
  score: number;
  confidence: number;
  topics: string[];
  created_at: string;
  last_updated: string;
  evidence_log: EvidenceEntry[];
}

export interface Ontology {
  axes: Axis[];
  axis_creation_rules_version: string;
  created_at: string | null;
  last_updated: string | null;
}

export function readOntology(): Ontology {
  const filePath = path.resolve(process.cwd(), "../state/ontology.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Ontology;
}

export function readBeliefState() {
  const filePath = path.resolve(process.cwd(), "../state/belief_state.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}
