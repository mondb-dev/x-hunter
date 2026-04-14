import { notFound } from "next/navigation";
import { readIntelligence, Claim, TierSummary, AxisScore } from "../../../lib/readIntelligence";

export const dynamic = "force-dynamic";

// ── Tier chip colours ─────────────────────────────────────────────────────────
const TIER_COLORS: Record<number, string> = {
  1: "#4ade80",
  2: "#86efac",
  3: "#fbbf24",
  4: "#fb923c",
  5: "#f87171",
};
function tierColor(tier: number | null): string {
  return TIER_COLORS[tier ?? 5] ?? "#94a3b8";
}

// ── Category display order ────────────────────────────────────────────────────
const CAT_ORDER = [
  "military_action",
  "nuclear",
  "diplomatic",
  "casualties_humanitarian",
  "proxy_regional",
  "threats_claims",
  "internal_politics",
  "misc",
];

const TIER_DESC: Record<string, string> = {
  tier_1: "Wire services & flagship outlets — highest reliability",
  tier_2: "Established outlets or credible analysts — known bias possible",
  tier_3: "OSINT trackers, niche journalists, mid-tier analysts",
  tier_4: "Opinion, activists, inconsistent quality",
  tier_5: "State propaganda, unverified, or unknown",
};

// ── Axis bar ──────────────────────────────────────────────────────────────────
function AxisBar({ id, axis }: { id: string; axis: AxisScore }) {
  const score = Math.max(-1, Math.min(1, axis.score));
  const pct = ((score + 1) / 2) * 100; // 0–100
  const isRight = score >= 0;
  const fillColor = isRight ? "#f59e0b" : "#60a5fa"; // amber / blue
  const confPct = Math.round(axis.confidence * 100);

  return (
    <div className="intel-axis">
      <div className="intel-axis-header">
        <span className="intel-axis-label">{axis.label}</span>
        <span className="intel-axis-conf">conf {confPct}%</span>
      </div>
      <div className="intel-axis-poles">
        <span>{axis.left_pole}</span>
        <span>{axis.right_pole}</span>
      </div>
      <div className="intel-axis-track">
        <div className="intel-axis-tick" style={{ left: "50%" }} />
        <div
          className="intel-axis-fill"
          style={{
            left: isRight ? "50%" : `${pct}%`,
            width: `${Math.abs(score) * 50}%`,
            background: fillColor,
          }}
        />
        <div className="intel-axis-marker" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Claim card ────────────────────────────────────────────────────────────────
function ClaimCard({ claim }: { claim: Claim }) {
  const tier = claim.source_tier;
  const color = tierColor(tier);
  return (
    <div className="intel-claim">
      <div className="intel-claim-meta">
        {claim.source_handle && (
          <span className="intel-claim-handle">@{claim.source_handle}</span>
        )}
        <span
          className="intel-tier-chip"
          style={{ background: color }}
          title={claim.source_tier_label ?? ""}
        >
          T{tier ?? "?"}
        </span>
        {claim.corroborating_count > 0 && (
          <span className="intel-corr">+{claim.corroborating_count} corr</span>
        )}
        {claim.contradicting_count > 0 && (
          <span className="intel-corr" style={{ color: "#f87171" }}>
            {claim.contradicting_count} contra
          </span>
        )}
      </div>
      <p className="intel-claim-text">{claim.claim_text}</p>
    </div>
  );
}

// ── Tier summary block ────────────────────────────────────────────────────────
function TierBlock({
  tierKey,
  tier,
  desc,
}: {
  tierKey: string;
  tier: TierSummary | null;
  desc: string;
}) {
  if (!tier || tier.count === 0) return null;
  const num = parseInt(tierKey.replace("tier_", ""), 10);
  const color = tierColor(num);

  return (
    <div className="intel-tier">
      <div className="intel-tier-header">
        <span
          className="intel-tier-chip"
          style={{ background: color }}
        >
          T{num}
        </span>
        <span className="intel-tier-count">{tier.count} sources</span>
        <span className="intel-tier-desc">{desc}</span>
      </div>
      <div className="intel-tier-handles">
        {tier.handles.slice(0, 12).map((h) => (
          <span key={h.handle} className="intel-tier-handle" title={h.tier_label}>
            @{h.handle}
          </span>
        ))}
        {tier.handles.length > 12 && (
          <span className="intel-tier-handle" style={{ opacity: 0.5 }}>
            +{tier.handles.length - 12} more
          </span>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function IranUsIsraelPage() {
  const intel = await readIntelligence();
  if (!intel) return notFound();

  const topAxes = Object.entries(intel.axis_scores)
    .sort((a, b) => b[1].confidence - a[1].confidence)
    .slice(0, 4);

  const orderedCats = CAT_ORDER.filter((c) => intel.categories[c]);

  const generatedDate = new Date(intel.generated_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="intel-header">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <p className="intel-eyebrow">Conflict Intelligence</p>
      <h1 className="intel-title">Iran / US / Israel — War</h1>
      <div className="intel-meta">
        <span>{intel.claim_count.toLocaleString()} claims</span>
        <span>·</span>
        <span>{intel.source_count} sources</span>
        <span>·</span>
        <span>Updated {generatedDate}</span>
      </div>
      <p className="intel-description">
        Claims are extracted from observed discourse and paraphrased for clarity.
        They reflect what sources assert — not verified facts. Source tier indicates
        reliability; lower is more credible.
      </p>

      {/* ── Axis bars ───────────────────────────────────────────────────── */}
      {topAxes.length > 0 && (
        <section className="intel-section">
          <h2 className="intel-section-label">Belief Axes</h2>
          <div className="intel-axes">
            {topAxes.map(([id, axis]) => (
              <AxisBar key={id} id={id} axis={axis} />
            ))}
          </div>
          <p className="intel-axes-note">
            Scores reflect accumulated evidence weighted by source credibility.
            Amber = right pole; blue = left pole.
          </p>
        </section>
      )}

      {/* ── Sebastian's take ────────────────────────────────────────────── */}
      {intel.sebastians_take?.summary && (
        <section className="intel-section intel-take">
          <h2 className="intel-section-label">Sebastian&apos;s Take</h2>
          <p>{intel.sebastians_take.summary}</p>
          {intel.sebastians_take.article_refs.length > 0 && (
            <div className="intel-take-refs">
              {intel.sebastians_take.article_refs.map((ref) => (
                <a
                  key={ref.date}
                  href={ref.url}
                  className="intel-take-ref"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Article {ref.date}
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Claims by category ──────────────────────────────────────────── */}
      <section className="intel-section">
        <h2 className="intel-section-label">Claims by Category</h2>
        <div className="intel-categories">
          {orderedCats.map((catId) => {
            const cat = intel.categories[catId];
            const isDefault = catId === "military_action";
            return (
              <details
                key={catId}
                className="intel-category"
                open={isDefault || undefined}
              >
                <summary className="intel-cat-header">
                  <span className="intel-cat-label">{cat.label}</span>
                  <span className="intel-cat-count">{cat.claim_count}</span>
                </summary>
                <div className="intel-claims">
                  {cat.claims.slice(0, 20).map((c) => (
                    <ClaimCard key={c.id} claim={c} />
                  ))}
                  {cat.claim_count > 20 && (
                    <p className="intel-cat-more">
                      + {cat.claim_count - 20} more claims (showing top 20)
                    </p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </section>

      {/* ── Contradictions ──────────────────────────────────────────────── */}
      {intel.contradictions.length > 0 && (
        <section className="intel-section">
          <h2 className="intel-section-label">
            Contradictions ({intel.contradictions.length})
          </h2>
          <div className="intel-contradictions">
            {intel.contradictions.map((contra) => (
              <div key={contra.group_id} className="intel-contradiction">
                <span className="intel-contra-cat">{contra.category}</span>
                <div className="intel-contra-sides">
                  {contra.sides.map((side, i) => (
                    <div key={i} className="intel-contra-claim">
                      <span
                        className="intel-contra-tier"
                        style={{ background: tierColor(side.source_tier) }}
                      >
                        T{side.source_tier ?? "?"}
                      </span>
                      {side.source_handle && (
                        <span className="intel-claim-handle">@{side.source_handle}</span>
                      )}
                      <p className="intel-contra-text">{side.claim_text}</p>
                      {i === 0 && (
                        <span className="intel-contra-vs">vs</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Source tiers ────────────────────────────────────────────────── */}
      <section className="intel-section">
        <h2 className="intel-section-label">Source Credibility</h2>
        <div className="intel-tiers">
          {(["tier_1", "tier_2", "tier_3", "tier_4", "tier_5"] as const).map(
            (key) => (
              <TierBlock
                key={key}
                tierKey={key}
                tier={intel.source_summary[key]}
                desc={TIER_DESC[key] ?? ""}
              />
            )
          )}
        </div>
      </section>

      {/* ── Methodology ─────────────────────────────────────────────────── */}
      <section className="intel-section">
        <div className="intel-methodology">
          <strong>Methodology:</strong> Claims are extracted from Sebastian&apos;s
          observed feed and paraphrased. Source credibility uses a 5-tier system
          informed by NewsGuard criteria, editorial track record, and behavioral
          signals (citation rate, stance diversity). No claim is presented as ground
          truth. The goal is structured epistemic mapping, not journalism.
        </div>
      </section>
    </div>
  );
}
