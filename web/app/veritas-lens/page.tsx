import { notFound } from "next/navigation";
import { readVerification, VerifiedClaim, ScoringBreakdown } from "../../lib/readVerification";
import CopyLinkButton from "../../components/CopyLinkButton";

/**
 * Gemini sometimes returns web_search_summary as a raw JSON blob — often truncated,
 * with no closing quote on the summary value.  Handle all cases:
 *   1. Full valid JSON  → JSON.parse
 *   2. Truncated JSON   → char-by-char scan from "summary": "
 *   3. Plain text       → return as-is
 */
function parseSummary(raw: string): string {
  if (!raw) return raw;
  // Strip code fences
  const s = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  // 1. Try full JSON parse
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null) {
      const v = parsed.summary ?? parsed.text ?? parsed.content ?? parsed.verdict_explanation;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch { /* fall through */ }
  // 2. Char-by-char scan — handles truncated JSON (no closing quote)
  const keyMatch = s.match(/"summary"\s*:\s*"/);
  if (!keyMatch || keyMatch.index === undefined) return raw;
  let pos = keyMatch.index + keyMatch[0].length;
  const buf: string[] = [];
  while (pos < s.length) {
    const ch = s[pos];
    if (ch === "\\" && pos + 1 < s.length) {
      const next = s[pos + 1];
      if (next === '"') buf.push('"');
      else if (next === 'n') buf.push(' ');
      else if (next === '\\') buf.push('\\');
      else buf.push(next);
      pos += 2;
    } else if (ch === '"') {
      break; // clean end of string value
    } else {
      buf.push(ch);
      pos++;
    }
  }
  const result = buf.join("").trim();
  return result || raw;
}

export const dynamic = "force-dynamic";

type FilterStatus = "all" | "supported" | "refuted" | "contested" | "unverified" | "expired";

const FILTER_LABELS: Record<FilterStatus, string> = {
  all: "All",
  supported: "Supported",
  refuted: "Refuted",
  contested: "Contested",
  unverified: "Unverified",
  expired: "Expired",
};

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
    <div id={claim.claim_id} className="verify-claim">
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

      {/* Origin: who said it and when */}
      {(claim.original_source || claim.claim_date) && (
        <div className="verify-claim-origin">
          {claim.original_source && (
            <span className="verify-claim-origin-source">Source: {claim.original_source}</span>
          )}
          {claim.claim_date && (
            <span className="verify-claim-origin-date">Reported: {claim.claim_date}</span>
          )}
        </div>
      )}

      <ConfidenceBar score={claim.confidence_score} breakdown={claim.scoring_breakdown} />

      {/* Web search summary */}
      {claim.web_search_summary && (
        <div className="verify-claim-summary">
          <p>{parseSummary(claim.web_search_summary)}</p>
        </div>
      )}

      {/* Supporting sources */}
      {claim.supporting_sources && claim.supporting_sources.length > 0 && (
        <div className="verify-claim-sources verify-claim-sources--supporting">
          <span className="verify-claim-sources-label" style={{ color: "#4ade80" }}>Supporting</span>
          {claim.supporting_sources.map((s, i) => (
            <div key={i} className="verify-claim-source-item">
              <span className="verify-claim-source-name">{s.name}</span>
              <span className="verify-claim-source-stance">{s.stance}</span>
            </div>
          ))}
        </div>
      )}

      {/* Dissenting sources */}
      {claim.dissenting_sources && claim.dissenting_sources.length > 0 && (
        <div className="verify-claim-sources verify-claim-sources--dissenting">
          <span className="verify-claim-sources-label" style={{ color: "#f87171" }}>Dissenting</span>
          {claim.dissenting_sources.map((s, i) => (
            <div key={i} className="verify-claim-source-item">
              <span className="verify-claim-source-name">{s.name}</span>
              <span className="verify-claim-source-stance">{s.stance}</span>
            </div>
          ))}
        </div>
      )}

      {/* Framing analysis */}
      {claim.framing_analysis && (
        <div className="verify-claim-framing">
          <span className="verify-claim-framing-label">Framing Analysis</span>
          <p>{claim.framing_analysis}</p>
        </div>
      )}

      {claim.evidence_urls && claim.evidence_urls.length > 0 && (
        <div className="verify-claim-evidence">
          <span className="verify-claim-evidence-label">Evidence:</span>
          {claim.evidence_urls.map((url, i) => {
            let hostname = url;
            try { hostname = new URL(url).hostname.replace("www.", ""); } catch {}
            return (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="verify-claim-evidence-link">
                {hostname}
              </a>
            );
          })}
        </div>
      )}

      <div className="verify-claim-footer">
        {claim.verified_at ? (
          <span className="verify-claim-date">
            Verified: {new Date(claim.verified_at).toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })}
          </span>
        ) : claim.created_at ? (
          <span className="verify-claim-date" style={{ color: "#64748b" }}>
            Observed: {new Date(claim.created_at).toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })}
          </span>
        ) : null}
        {claim.tweet_url && (
          <a href={claim.tweet_url} target="_blank" rel="noopener noreferrer" className="verify-claim-tweet">
            View tweet
          </a>
        )}
        {claim.category && (
          <span className="verify-claim-category">{claim.category.replace(/_/g, " ")}</span>
        )}
        <CopyLinkButton url={`/veritas-lens#${claim.claim_id}`} />
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function VerifiedPage({
  searchParams,
}: {
  searchParams?: Promise<{ filter?: string }> | { filter?: string };
}) {
  const data = await readVerification();
  if (!data) return notFound();

  const params = searchParams ? await searchParams : undefined;
  const { stats, claims } = data;
  const activeFilter = (params?.filter ?? "all") as FilterStatus;
  const filteredClaims = (activeFilter === "all"
    ? [...claims]
    : claims.filter((c) => c.status === activeFilter)
  ).sort((a, b) => {
    const aDate = a.verified_at ?? a.created_at;
    const bDate = b.verified_at ?? b.created_at;
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });

  const avgConfidence = claims.length
    ? Math.round((claims.reduce((s, c) => s + c.confidence_score, 0) / claims.length) * 100)
    : 0;

  const filterCounts: Record<FilterStatus, number> = {
    all: claims.length,
    supported: stats.supported,
    refuted: stats.refuted,
    contested: stats.contested,
    unverified: stats.unverified,
    expired: stats.expired,
  };

  return (
    <div className="verify-page">
      <header className="verify-header">
        <span className="verify-eyebrow">Veritas Lens</span>
        <h1 className="verify-title">Claim Verification</h1>
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

      <div className="verify-filters">
        {(Object.keys(FILTER_LABELS) as FilterStatus[]).map((f) => (
          filterCounts[f] > 0 || f === "all" ? (
            <a
              key={f}
              href={f === "all" ? "/verified" : `/verified?filter=${f}`}
              className={`verify-filter-tab${activeFilter === f ? " verify-filter-tab--active" : ""}`}
            >
              {FILTER_LABELS[f]}
              <span className="verify-filter-count">{filterCounts[f]}</span>
            </a>
          ) : null
        ))}
      </div>

      <div className="verify-claims">
        {filteredClaims.length === 0 && (
          <p className="verify-empty">No {activeFilter === "all" ? "" : activeFilter + " "}claims yet. Check back soon.</p>
        )}
        {filteredClaims.map((claim) => (
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
