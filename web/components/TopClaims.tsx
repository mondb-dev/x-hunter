import Link from "next/link";
import { readVerification, VerifiedClaim } from "@/lib/readVerification";

const STATUS_COLORS: Record<string, string> = {
  supported: "#4ade80",
  refuted: "#f87171",
  contested: "#fbbf24",
  unverified: "#94a3b8",
  expired: "#64748b",
};

const STATUS_ORDER: Record<string, number> = {
  supported: 0,
  refuted: 1,
  contested: 2,
  unverified: 3,
  expired: 4,
};

function pickTopClaims(claims: VerifiedClaim[], n = 5): VerifiedClaim[] {
  return [...claims]
    .filter((c) => c.status !== "expired")
    .sort((a, b) => {
      const statusDiff = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      if (statusDiff !== 0) return statusDiff;
      return b.confidence_score - a.confidence_score;
    })
    .slice(0, n);
}

function ClaimRow({ claim }: { claim: VerifiedClaim }) {
  const color = STATUS_COLORS[claim.status] ?? "#94a3b8";
  const pct = Math.round(claim.confidence_score * 100);
  const source = claim.source_handle
    ? `@${claim.source_handle}`
    : claim.original_source ?? null;

  return (
    <div className="top-claim-row">
      <div className="top-claim-left">
        <span
          className="top-claim-status"
          style={{ background: color, color: "#000" }}
        >
          {claim.status}
        </span>
        <p className="top-claim-text">{claim.claim_text}</p>
      </div>
      <div className="top-claim-right">
        {source && <span className="top-claim-source">{source}</span>}
        <span className="top-claim-conf" style={{ color }}>{pct}%</span>
      </div>
    </div>
  );
}

export default async function TopClaims() {
  try {
    const data = await readVerification();
    if (!data || data.claims.length === 0) return null;

    const top = pickTopClaims(data.claims);
    if (top.length === 0) return null;

    return (
      <div className="top-claims-wrap">
        <div className="top-claims-header">
          <span className="top-claims-label">veritas lens</span>
          <Link href="/verified" className="top-claims-view-all">
            view all →
          </Link>
        </div>
        <div className="top-claims-list">
          {top.map((claim) => (
            <Link
              key={claim.claim_id}
              href={`/verified#${claim.claim_id}`}
              className="top-claims-link"
              style={{ textDecoration: "none" }}
            >
              <ClaimRow claim={claim} />
            </Link>
          ))}
        </div>
      </div>
    );
  } catch {
    return null;
  }
}
