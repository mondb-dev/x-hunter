import { notFound } from "next/navigation";
import { readVerification, VerifiedClaim, ScoringBreakdown, InvestigationData } from "../../lib/readVerification";
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

// ── Topic tag derivation ────────────────────────────────────────────────────
function deriveTag(claim: VerifiedClaim): string {
  const haystack = [
    claim.claim_text,
    claim.original_source ?? "",
    claim.category ?? "",
  ].join(" ").toLowerCase();
  if (/\biran\b|hormuz|iranian\b|irgc|tehran|khamenei|pezeshkian/.test(haystack)) return "iran";
  if (/\bukraine\b|\brussia\b|russian\b|zelensky|kyiv|moscow|putin/.test(haystack)) return "ukraine";
  if (/\bisrael\b|\bidf\b|\bgaza\b|palestine|hamas|jenin|hezbollah|netanyahu|west bank/.test(haystack)) return "israel";
  if (/\bchina\b|chinese\b|taiwan|beijing|\bxi\b|ccp|uyghur/.test(haystack)) return "china";
  if (/\btrump\b|biden|\bice\b|congress|federal reserve|\bdoj\b|\bdoge\b|republican|democrat|white house|tariff|\bmaga\b/.test(haystack)) return "us-politics";
  if (/\boil\b|crude\b|energy\b|opec|sanctions\b|gas price|inflation/.test(haystack)) return "economy";
  return "other";
}

const TAG_ORDER: string[] = ["iran", "ukraine", "israel", "us-politics", "china", "economy", "other"];
const TAG_LABELS: Record<string, string> = {
  iran: "Iran War",
  ukraine: "Ukraine / Russia",
  israel: "Israel / Gaza",
  china: "China",
  "us-politics": "US Politics",
  economy: "Economy",
  other: "Other",
};

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

function InvestigationSection({ inv }: { inv: InvestigationData }) {
  return (
    <details className="verify-investigation">
      <summary className="verify-investigation-toggle">
        Deep Investigation
        <span className="verify-investigation-badge">
          {inv.sub_questions.length} sub-questions, {inv.supporting_evidence.length} supporting, {inv.contradicting_evidence.length} contradicting
        </span>
      </summary>

      {inv.key_finding && (
        <div className="verify-investigation-finding">
          <strong>Key finding:</strong> {inv.key_finding}
        </div>
      )}

      {inv.attribution_chain.length > 0 && (
        <div className="verify-investigation-chain">
          <span className="verify-investigation-section-label">Attribution Chain</span>
          <div className="verify-investigation-chain-list">
            {inv.attribution_chain.map((a, i) => (
              <div key={i} className="verify-investigation-chain-item">
                <span className="verify-investigation-chain-level">L{a.level}</span>
                <span className="verify-investigation-chain-desc">{a.description}</span>
                {a.url && (
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="verify-investigation-chain-link">source</a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {inv.sub_questions.length > 0 && (
        <div className="verify-investigation-questions">
          <span className="verify-investigation-section-label">Sub-Questions</span>
          {inv.sub_questions.map((sq, i) => (
            <div key={i} className="verify-investigation-question">
              <div className="verify-investigation-q">
                <strong>Q:</strong> {sq.question}
                <span className="verify-investigation-q-conf" style={{
                  color: sq.confidence >= 0.8 ? "#4ade80" : sq.confidence >= 0.5 ? "#fbbf24" : "#f87171"
                }}>
                  {Math.round(sq.confidence * 100)}%
                </span>
              </div>
              <div className="verify-investigation-a">{sq.answer}</div>
              {sq.sources && sq.sources.length > 0 && (
                <div className="verify-investigation-q-sources">
                  {sq.sources.map((s, j) => (
                    <a key={j} href={s.url} target="_blank" rel="noopener noreferrer"
                       className="verify-investigation-q-source" title={s.quote || s.title || ""}>
                      {s.domain || s.title || "source"}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {inv.supporting_evidence.length > 0 && (
        <div className="verify-investigation-evidence verify-investigation-evidence--supporting">
          <span className="verify-investigation-section-label" style={{ color: "#4ade80" }}>Supporting Evidence</span>
          {inv.supporting_evidence.map((e, i) => (
            <div key={i} className="verify-investigation-evidence-item">
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="verify-investigation-evidence-domain">
                {e.domain || "source"}
              </a>
              {e.quote && <span className="verify-investigation-evidence-quote">&ldquo;{e.quote}&rdquo;</span>}
              {e.relevance && <span className="verify-investigation-evidence-relevance">{e.relevance}</span>}
            </div>
          ))}
        </div>
      )}

      {inv.contradicting_evidence.length > 0 && (
        <div className="verify-investigation-evidence verify-investigation-evidence--contradicting">
          <span className="verify-investigation-section-label" style={{ color: "#f87171" }}>Contradicting Evidence</span>
          {inv.contradicting_evidence.map((e, i) => (
            <div key={i} className="verify-investigation-evidence-item">
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="verify-investigation-evidence-domain">
                {e.domain || "source"}
              </a>
              {e.quote && <span className="verify-investigation-evidence-quote">&ldquo;{e.quote}&rdquo;</span>}
              {e.relevance && <span className="verify-investigation-evidence-relevance">{e.relevance}</span>}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

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
      <details className="verify-breakdown-details">
        <summary className="verify-breakdown-summary">Score breakdown</summary>
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
      </details>
    </div>
  );
}

function ClaimCard({ claim }: { claim: VerifiedClaim }) {
  const tier = claim.source_tier;
  const tierColor = TIER_COLORS[tier ?? 5] ?? "#94a3b8";
  const tierLabel = TIER_LABELS[tier ?? 5] ?? "Unknown";

  return (
    <div id={claim.claim_id} className={`verify-claim verify-claim--${claim.status}`}>
      <div className="verify-claim-header">
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
          {claim.supporting_sources.map((s: any, i: number) => (
            <div key={i} className="verify-claim-source-item">
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="verify-claim-source-name verify-claim-source-link">{s.name}</a>
              ) : (
                <span className="verify-claim-source-name">{s.name}</span>
              )}
              {(s.excerpt || s.stance) && <span className="verify-claim-source-stance">{s.excerpt || s.stance}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Dissenting sources */}
      {claim.dissenting_sources && claim.dissenting_sources.length > 0 && (
        <div className="verify-claim-sources verify-claim-sources--dissenting">
          <span className="verify-claim-sources-label" style={{ color: "#f87171" }}>Dissenting</span>
          {claim.dissenting_sources.map((s: any, i: number) => (
            <div key={i} className="verify-claim-source-item">
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="verify-claim-source-name verify-claim-source-link">{s.name}</a>
              ) : (
                <span className="verify-claim-source-name">{s.name}</span>
              )}
              {(s.excerpt || s.stance) && <span className="verify-claim-source-stance">{s.excerpt || s.stance}</span>}
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

      {/* Deep investigation */}
      {claim.investigation && (
        <InvestigationSection inv={claim.investigation} />
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
  searchParams?: Promise<{ filter?: string; tag?: string }> | { filter?: string; tag?: string };
}) {
  const data = await readVerification();
  if (!data) return notFound();

  const params = searchParams ? await searchParams : undefined;
  const { stats, claims } = data;
  const activeFilter = (params?.filter ?? "all") as FilterStatus;
  const activeTag = params?.tag ?? "all";

  function buildUrl(tag: string, filter: FilterStatus): string {
    const p = new URLSearchParams();
    if (filter !== "all") p.set("filter", filter);
    if (tag !== "all") p.set("tag", tag);
    const qs = p.toString();
    return `/veritas-lens${qs ? "?" + qs : ""}`;
  }

  const filteredClaims = (activeFilter === "all"
    ? [...claims]
    : claims.filter((c) => c.status === activeFilter)
  )
    .filter((c) => activeTag === "all" || deriveTag(c) === activeTag)
    .sort((a, b) => {
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

  const tagCounts = TAG_ORDER.reduce((acc, tag) => {
    acc[tag] = claims.filter((c) => deriveTag(c) === tag).length;
    return acc;
  }, {} as Record<string, number>);

  const showGrouped = activeFilter === "all" && activeTag === "all";
  const groupedClaims: Record<string, VerifiedClaim[]> = showGrouped
    ? TAG_ORDER.reduce((acc, tag) => {
        const items = filteredClaims.filter((c) => deriveTag(c) === tag);
        if (items.length > 0) acc[tag] = items;
        return acc;
      }, {} as Record<string, VerifiedClaim[]>)
    : {};

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
        {stats.expired > 0 && <StatCard label="Expired" value={stats.expired} color="#64748b" />}
      </div>

      <div className="verify-filters">
        {(Object.keys(FILTER_LABELS) as FilterStatus[]).map((f) => (
          filterCounts[f] > 0 || f === "all" ? (
            <a
              key={f}
              href={buildUrl(activeTag, f)}
              className={`verify-filter-tab${activeFilter === f ? " verify-filter-tab--active" : ""}`}
            >
              {FILTER_LABELS[f]}
              <span className="verify-filter-count">{filterCounts[f]}</span>
            </a>
          ) : null
        ))}
      </div>

      <div className="verify-tag-filters">
        <a
          href={buildUrl("all", activeFilter)}
          className={`verify-tag-tab${activeTag === "all" ? " verify-tag-tab--active" : ""}`}
        >
          All topics
        </a>
        {TAG_ORDER.filter((tag) => tagCounts[tag] > 0).map((tag) => (
          <a
            key={tag}
            href={buildUrl(tag, activeFilter)}
            className={`verify-tag-tab${activeTag === tag ? " verify-tag-tab--active" : ""}`}
          >
            {TAG_LABELS[tag]}
            <span className="verify-filter-count">{tagCounts[tag]}</span>
          </a>
        ))}
      </div>

      {showGrouped ? (
        <div className="verify-grouped">
          {TAG_ORDER.filter((tag) => groupedClaims[tag]).map((tag) => (
            <div key={tag} className="verify-topic-group">
              <div className="verify-topic-header">
                <h3 className="verify-topic-label">{TAG_LABELS[tag]}</h3>
                <a href={buildUrl(tag, "all")} className="verify-topic-see-all">
                  {groupedClaims[tag].length} {groupedClaims[tag].length === 1 ? "claim" : "claims"}
                </a>
              </div>
              <div className="verify-claims">
                {groupedClaims[tag].map((claim) => (
                  <ClaimCard key={claim.claim_id} claim={claim} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="verify-claims">
          {filteredClaims.length === 0 && (
            <p className="verify-empty">No claims found for this filter.</p>
          )}
          {filteredClaims.map((claim) => (
            <ClaimCard key={claim.claim_id} claim={claim} />
          ))}
        </div>
      )}

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
