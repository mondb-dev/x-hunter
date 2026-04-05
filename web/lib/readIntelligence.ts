import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

const EXPORT_PATH = path.join(DATA_ROOT, "state/intelligence_export.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Claim {
  id: string;
  claim_text: string;
  stance: "left" | "right" | "neutral";
  axis_id: string | null;
  source_handle: string | null;
  source_url: string | null;
  source_tier: number | null;
  source_tier_label: string | null;
  source_ng_score: number | null;
  source_lean: string | null;
  source_tier_confidence: string | null;
  source_ng_assessed_by: string | null;
  corroborating_count: number;
  contradicting_count: number;
  status: string;
  observed_at: string;
}

export interface Category {
  label: string;
  claim_count: number;
  claims: Claim[];
}

export interface ContradictionSide {
  stance: string;
  source_handle: string | null;
  source_tier: number | null;
  source_tier_label: string | null;
  claim_text: string;
}

export interface Contradiction {
  group_id: string;
  category: string;
  sides: [ContradictionSide, ContradictionSide];
}

export interface TierHandle {
  handle: string;
  tier_label: string;
  political_lean: string | null;
  ng_score: number | null;
  tier_confidence: string | null;
  ng_assessed_by: string | null;
  entry_count: number;
  citation_rate: number | null;
}

export interface TierSummary {
  count: number;
  handles: TierHandle[];
}

export interface AxisScore {
  score: number;
  confidence: number;
  label: string;
  left_pole: string;
  right_pole: string;
}

export interface SebastiansTake {
  article_refs: { date: string; url: string }[];
  summary: string;
}

export interface IntelligenceExport {
  topic: string;
  topic_label: string;
  generated_at: string;
  source_count: number;
  claim_count: number;
  categories: Record<string, Category>;
  contradictions: Contradiction[];
  source_summary: {
    tier_1: TierSummary | null;
    tier_2: TierSummary | null;
    tier_3: TierSummary | null;
    tier_4: TierSummary | null;
    tier_5: TierSummary | null;
  };
  axis_scores: Record<string, AxisScore>;
  sebastians_take: SebastiansTake;
}

// ── Reader ────────────────────────────────────────────────────────────────────

export function readIntelligence(): IntelligenceExport | null {
  try {
    if (!fs.existsSync(EXPORT_PATH)) return null;
    const raw = fs.readFileSync(EXPORT_PATH, "utf-8");
    return JSON.parse(raw) as IntelligenceExport;
  } catch {
    return null;
  }
}
