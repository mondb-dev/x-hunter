import { cachedReadFileSync } from "./fileCache";

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

export interface InvestigationSource {
  url: string;
  domain: string;
  title?: string;
  quote?: string;
  date?: string;
  relevance?: string;
}

export interface SubQuestion {
  question: string;
  answer: string;
  confidence: number;
  sources: InvestigationSource[];
}

export interface AttributionLevel {
  level: number;
  description: string;
  url?: string;
}

export interface InvestigationData {
  investigation_id: string;
  sub_questions: SubQuestion[];
  attribution_chain: AttributionLevel[];
  supporting_evidence: InvestigationSource[];
  contradicting_evidence: InvestigationSource[];
  overall_verdict: string;
  summary: string;
  key_finding: string;
  duration_seconds: number;
  created_at: string;
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
  investigation_depth?: string;
  investigation?: InvestigationData;
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
    const raw = cachedReadFileSync("state/verification_export.json");
    return JSON.parse(raw) as VerificationExport;
  } catch {
    return null;
  }
}
