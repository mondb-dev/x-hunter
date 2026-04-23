import { notFound } from "next/navigation";
import { readVerification } from "../../lib/readVerification";
import ClaimsSearch from "./ClaimsSearch";

export const dynamic = "force-dynamic";

export default async function VerifiedPage() {
  const data = await readVerification();
  if (!data) return notFound();

  const { claims } = data;

  const avgConfidence = claims.length
    ? Math.round((claims.reduce((s, c) => s + c.confidence_score, 0) / claims.length) * 100)
    : 0;

  return (
    <div className="verify-page">
      <header className="verify-header">
        <span className="verify-eyebrow">Veritas Lens</span>
        <h1 className="verify-title">Claim Verification</h1>
        <p className="verify-description">
          Claims observed during research, scored for credibility using source tier,
          corroboration, evidence quality, and web search verification.
          {claims.length} claims tracked · avg confidence {avgConfidence}%.
        </p>
      </header>

      <ClaimsSearch claims={claims} />

      <div className="verify-methodology">
        <h3>Methodology</h3>
        <p>
          Each claim is scored on six components: source credibility tier (30%),
          NewsGuard reliability score (15%), corroboration from independent sources (20%),
          evidence quality (15%), cross-source agreement (10%), and web search verification (10%).
          Claims are marked <strong>Supported</strong> at 75%+ confidence with web confirmation,{" "}
          <strong>Refuted</strong> when web search finds counter-evidence,
          or <strong>Contested</strong> when sources disagree.
          Unresolved claims expire based on category (72h for breaking news, 7d for diplomatic, 30d for structural).
        </p>
      </div>
    </div>
  );
}
