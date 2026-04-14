import { gcsFileExists, gcsReadFile } from "./gcs";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScoringBreakdown {
  source_tier: number;
  newsguard: number;
  corroboration: number;
  evidence_quality: number;
  cross_source: number;
  web_search: number;
}

export interface SourceStance {
  name: string;
  stance: string;
}

export interface VerifiedClaim {
  claim_id: string;
  claim_text: string;
  status: "supported" | "refuted" | "contested" | "unverified" | "expired";
  confidence_score: number;
  scoring_breakdown: ScoringBreakdown;
  source_handle: string | null;
  source_tier: number | null;
  evidence_urls: string[];
  tweet_url: string | null;
  category: string | null;
  related_axis_id: string | null;
  verification_count: number;
  verified_at: string | null;
  created_at: string;
  original_source: string | null;
  claim_date: string | null;
  supporting_sources: SourceStance[];
  dissenting_sources: SourceStance[];
  framing_analysis: string | null;
  web_search_summary: string | null;
}

export interface VerificationStats {
  total: number;
  supported: number;
  refuted: number;
  contested: number;
  unverified: number;
  expired: number;
}

export interface VerificationExport {
  generated_at: string;
  stats: VerificationStats;
  claims: VerifiedClaim[];
}

// ── Reader ────────────────────────────────────────────────────────────────────

export async function readVerification(): Promise<VerificationExport | null> {
  try {
    const exists = await gcsFileExists("state/verification_export.json");
    if (!exists) return null;
    const raw = await gcsReadFile("state/verification_export.json");
    return JSON.parse(raw) as VerificationExport;
  } catch {
    return null;
  }
}
