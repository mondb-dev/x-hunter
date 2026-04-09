import { notFound } from "next/navigation";
import { readVerification, VerifiedClaim, ScoringBreakdown } from "../../lib/readVerification";

export const dynamic = "force-dynamic";

// ── Status colours ───────────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, string> = {
  supported: "#4ade80",
  refuted: "#f87171",
  contested: "#fbbf24",
  unverified: "#94a3b8",
  expired: "#64748b",
};

const STATUS_LABELS: Record<string, string> = {
  supported: "Supported",
  refuted: "Refuted",
  contested: "Contested",
  unverified: "Unverified",
  expired: "Expired",
};

// ── Tier chip colours ────────────────────────────────────────────────────────
const TIER_COLORS: Record<number, string> = {
  1: "#4ade80",
  2: "#86efac",
  3: "#fbbf24",
  4: "#fb923c",
  5: "#f87171",
};
const TIER_LABELS: Record<number, string> = {
  1: "Institutional",
  2: "Official",
  3: "Analyst",
  4: "Commentator",
  5: "Unverified",
};

// ── Scoring component labels ─────────────────────────────────────────────────
const SCORE_LABELS: Record<keyof ScoringBreakdown, string> = {
  source_tier: "Source Tier",
  newsguard: "NewsGuard",
  corroboration: "Corroboration",
  evidence_quality: "Evidence Quality",
  cross_source: "Cross-Source",
  web_search: "Web Search",
};

const SCORE_COLORS: Record<keyof ScoringBreakdown, string> = {
  source_tier: "#60a5fa",
  newsguard: "#a78bfa",
  corroboration: "#4ade80",
  evidence_quality: "#fbbf24",
  cross_source: "#f472b6",
  web_search: "#fb923c",
};

// ── Components ───────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="verify-stat">
      <div className="verify-stat-value" style={{ color }}>{value}</div>
      <div className="verify-stat-label">{label}</div>
    </div>
  );
}

function ConfidenceBar({ score, breakdown }: { score: number; breakdown: ScoringBreakdown }) {
  const pct = Math.round(score * 100);
  const barColor = pct >= 75 ? "#4ade80" : pct >= 50 ? "#fbbf24" : pct >= 25 ? "#fb923c" : "#f87171";

  return (
    <div className="verify-confidence">
      <div className="verify-confidence-header">
        <span className="verify-confidence-label">Confidence</span>
        <span className="verify-confidence-pct" style={{ color: barColor }}>{pct}%</span>
      </div>
      <div className="verify-confidence-track">
        <div
          className="verify-confidence-fill"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
      <div className="verify-breakdown">
        {(Object.keys(breakdown) as (keyof ScoringBreakdown)[]).map((key) => {
          const val = breakdown[key];
          const w = Math.round(Math.abs(val) * 100);
          return (
            <div key={key} className="verify-breakdown-row">
              <span className="verify-breakdown-label">{SCORE_LABELS[key]}</span>
              <div className="verify-breakdown-track">
                <div
                  className="verify-breakdown-fill"
                  style={{ width: `${w}%`, background: SCORE_COLORS[key] }}
                />
              </div>
              <span className="verify-breakdown-val">{w}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ClaimCard({ claim }: { claim: VerifiedClaim }) {
  const statusColor = STATUS_COLORS[claim.status] ?? "#94a3b8";
  const statusLabel = STATUS_LABELS[claim.status] ?? claim.status;
  const tier = claim.source_tier;
  const tierColor = TIER_COLORS[tier ?? 5] ?? "#94a3b8";
  const tierLabel = TIER_LABELS[tier ?? 5] ?? "Unknown";

  return (
    <div className="verify-claim">
      <div className="verify-claim-header">
        <span
          className="verify-claim-status"
          style={{ background: statusColor, color: "#000" }}
        >
          {statusLabel}
        </span>
        {claim.source_handle && (
          <a
            href={`https://x.com/${claim.source_handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="verify-claim-handle"
          >
            @{claim.source_handle}
          </a>
        )}
        {tier && (
          <span className="verify-claim-tier" style={{ borderColor: tierColor, color: tierColor }}>
            Tier {tier} ({tierLabel})
          </span>
        )}
      </div>

      <p className="verify-claim-text">{claim.claim_text}</p>

      <ConfidenceBar score={claim.confidence_score} breakdown={claim.scoring_breakdown} />

      {claim.evidence_urls && claim.evidence_urls.length > 0 && (
        <div className="verify-claim-evidence">
          <span className="verify-claim-evidence-label">Evidence:</span>
          {claim.evidence_urls.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="verify-claim-evidence-link">
              {new URL(url).hostname.replace("www.", "")}
            </a>
          ))}
        </div>
      )}

      <div className="verify-claim-footer">
        {claim.verified_at && (
          <span className="verify-claim-date">
            Verified: {new Date(claim.verified_at).toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })}
          </span>
        )}
        {claim.tweet_url && (
          <a href={claim.tweet_url} target="_blank" rel="noopener noreferrer" className="verify-claim-tweet">
            View tweet
          </a>
        )}
        {claim.category && (
          <span className="verify-claim-category">{claim.category.replace(/_/g, " ")}</span>
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function VerifiedPage() {
  const data = readVerification();
  if (!data) return notFound();

  const { stats, claims } = data;
  const avgConfidence = claims.length
    ? Math.round((claims.reduce((s, c) => s + c.confidence_score, 0) / claims.length) * 100)
    : 0;

  return (
    <div className="verify-page">
      <header className="verify-header">
        <span className="verify-eyebrow">Claim Verification</span>
        <h1 className="verify-title">Sebastian&apos;s Fact Checks</h1>
        <p className="verify-description">
          Claims observed during research, scored for credibility using source tier,
          corroboration, evidence quality, and web search verification.
          Average confidence: {avgConfidence}%.
        </p>
      </header>

      <div className="verify-stats">
        <StatCard label="Total" value={stats.total} color="#e2e8f0" />
        <StatCard label="Supported" value={stats.supported} color="#4ade80" />
        <StatCard label="Refuted" value={stats.refuted} color="#f87171" />
        <StatCard label="Contested" value={stats.contested} color="#fbbf24" />
        <StatCard label="Unverified" value={stats.unverified} color="#94a3b8" />
      </div>

      <div className="verify-claims">
        {claims.length === 0 && (
          <p className="verify-empty">No claims verified yet. Check back soon.</p>
        )}
        {claims.map((claim) => (
          <ClaimCard key={claim.claim_id} claim={claim} />
        ))}
      </div>

      <div className="verify-methodology">
        <h3>Methodology</h3>
        <p>
          Each claim is scored on six components: source credibility tier (30%),
          NewsGuard reliability score (15%), corroboration from independent sources (20%),
          evidence quality (15%), cross-source agreement (10%), and web search verification (10%).
          Claims are marked <strong>Supported</strong> at 75%+ confidence with web confirmation,
          <strong>Refuted</strong> when web search finds counter-evidence,
          or <strong>Contested</strong> when sources disagree.
          Unresolved claims expire based on category (72h for breaking news, 7d for diplomatic, 30d for structural).
        </p>
      </div>
    </div>
  );
}
