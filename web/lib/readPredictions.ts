import { cachedReadFileSync } from "./fileCache";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResolutionStatus = "pending" | "correct" | "wrong" | "partial" | "expired";

export interface Prediction {
  id?: string;
  ts: string;
  axes_count: number;
  top_axes: string[];
  prediction: string;
  confidence_pct: number | null;
  resolution_status: ResolutionStatus;
  deadline_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  tweet_url: string | null;
}

export interface PredictionStats {
  total: number;
  correct: number;
  wrong: number;
  partial: number;
  pending: number;
  expired: number;
  accuracy: number | null;
}

export interface PredictionExport {
  generated_at: string;
  stats: PredictionStats;
  predictions: Prediction[];
}

// ── Reader ────────────────────────────────────────────────────────────────────

export async function readPredictions(): Promise<PredictionExport | null> {
  try {
    const raw = cachedReadFileSync("state/prediction_export.json");
    const data = JSON.parse(raw) as PredictionExport;

    // Normalize old-format entries (no id/confidence/resolution fields)
    data.predictions = (data.predictions || []).map((p) => ({
      id: p.id ?? undefined,
      ts: p.ts,
      axes_count: p.axes_count ?? 0,
      top_axes: p.top_axes ?? [],
      prediction: p.prediction,
      confidence_pct: p.confidence_pct ?? null,
      resolution_status: (p.resolution_status as ResolutionStatus) ?? "pending",
      deadline_at: p.deadline_at ?? null,
      resolved_at: p.resolved_at ?? null,
      resolution_note: p.resolution_note ?? null,
      tweet_url: p.tweet_url ?? null,
    }));

    return data;
  } catch {
    return null;
  }
}
