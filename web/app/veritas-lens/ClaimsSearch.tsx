"use client";

import { useState, useMemo } from "react";
import { VerifiedClaim, ScoringBreakdown, InvestigationData } from "../../lib/readVerification";
import CopyLinkButton from "../../components/CopyLinkButton";

// ── parseSummary ─────────────────────────────────────────────────────────────
function parseSummary(raw: string): string {
  if (!raw) return raw;
  const s = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null) {
      const v = parsed.summary ?? parsed.text ?? parsed.content ?? parsed.verdict_explanation;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch { /* fall through */ }
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
      break;
    } else {
      buf.push(ch);
      pos++;
    }
  }
  return buf.join("").trim() || raw;
}

// ── Tag derivation ───────────────────────────────────────────────────────────
function deriveTag(claim: VerifiedClaim): string {
  const haystack = [claim.claim_text, claim.original_source ?? "", claim.category ?? ""].join(" ").toLowerCase();
  if (/\biran\b|hormuz|iranian\b|irgc|tehran|khamenei|pezeshkian/.test(haystack)) return "iran";
  if (/\bukraine\b|\brussia\b|russian\b|zelensky|kyiv|moscow|putin/.test(haystack)) return "ukraine";
  if (/\bisrael\b|\bidf\b|\bgaza\b|palestine|hamas|jenin|hezbollah|netanyahu|west bank/.test(haystack)) return "israel";
  if (/\bchina\b|chinese\b|taiwan|beijing|\bxi\b|ccp|uyghur/.test(haystack)) return "china";
  if (/\btrump\b|biden|\bice\b|congress|federal reserve|\bdoj\b|\bdoge\b|republican|democrat|white house|tariff|\bmaga\b/.test(haystack)) return "us-politics";
  if (/\boil\b|crude\b|energy\b|opec|sanctions\b|gas price|inflation/.test(haystack)) return "economy";
  return "other";
}

const TAG_ORDER = ["iran", "ukraine", "israel", "us-politics", "china", "economy", "other"];
const TAG_LABELS: Record<string, string> = {
  iran: "Iran War",
  ukraine: "Ukraine / Russia",
  israel: "Israel / Gaza",
  china: "China",
  "us-politics": "US Politics",
  economy: "Economy",
  other: "Other",
};

// ── Style constants ──────────────────────────────────────────────────────────
const TIER_COLORS: Record<number, string> = { 1: "#4ade80", 2: "#86efac", 3: "#fbbf24", 4: "#fb923c", 5: "#f87171" };
const TIER_LABELS: Record<number, string> = { 1: "Institutional", 2: "Official", 3: "Analyst", 4: "Commentator", 5: "Unverified" };

const SCORE_LABELS: Record<keyof ScoringBreakdown, string> = {
  source_tier: "Source Tier", newsguard: "NewsGuard", corroboration: "Corroboration",
  evidence_quality: "Evidence Quality", cross_source: "Cross-Source", web_search: "Web Search",
};
const SCORE_COLORS: Record<keyof ScoringBreakdown, string> = {
  source_tier: "#60a5fa", newsguard: "#a78bfa", corroboration: "#4ade80",
  evidence_quality: "#fbbf24", cross_source: "#f472b6", web_search: "#fb923c",
};

// ── Sub-components ───────────────────────────────────────────────────────────
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
        <div className="verify-investigation-finding"><strong>Key finding:</strong> {inv.key_finding}</div>
      )}
      {inv.attribution_chain.length > 0 && (
        <div className="verify-investigation-chain">
          <span className="verify-investigation-section-label">Attribution Chain</span>
          <div className="verify-investigation-chain-list">
            {inv.attribution_chain.map((a, i) => (
              <div key={i} className="verify-investigation-chain-item">
                <span className="verify-investigation-chain-level">L{a.level}</span>
                <span className="verify-investigation-chain-desc">{a.description}</span>
                {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" className="verify-investigation-chain-link">source</a>}
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
                <span className="verify-investigation-q-conf" style={{ color: sq.confidence >= 0.8 ? "#4ade80" : sq.confidence >= 0.5 ? "#fbbf24" : "#f87171" }}>
                  {Math.round(sq.confidence * 100)}%
                </span>
              </div>
              <div className="verify-investigation-a">{sq.answer}</div>
              {sq.sources && sq.sources.length > 0 && (
                <div className="verify-investigation-q-sources">
                  {sq.sources.map((s, j) => (
                    <a key={j} href={s.url} target="_blank" rel="noopener noreferrer" className="verify-investigation-q-source" title={s.quote || s.title || ""}>
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
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="verify-investigation-evidence-domain">{e.domain || "source"}</a>
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
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="verify-investigation-evidence-domain">{e.domain || "source"}</a>
              {e.quote && <span className="verify-investigation-evidence-quote">&ldquo;{e.quote}&rdquo;</span>}
              {e.relevance && <span className="verify-investigation-evidence-relevance">{e.relevance}</span>}
            </div>
          ))}
        </div>
      )}
    </details>
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
        <div className="verify-confidence-fill" style={{ width: `${pct}%`, background: barColor }} />
      </div>
      <details className="verify-breakdown-details">
        <summary className="verify-breakdown-summary">Score breakdown</summary>
        <div className="verify-breakdown">
          {(Object.keys(breakdown) as (keyof ScoringBreakdown)[]).map((key) => {
            const w = Math.round(Math.abs(breakdown[key]) * 100);
            return (
              <div key={key} className="verify-breakdown-row">
                <span className="verify-breakdown-label">{SCORE_LABELS[key]}</span>
                <div className="verify-breakdown-track">
                  <div className="verify-breakdown-fill" style={{ width: `${w}%`, background: SCORE_COLORS[key] }} />
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
          <a href={`https://x.com/${claim.source_handle}`} target="_blank" rel="noopener noreferrer" className="verify-claim-handle">
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
      {(claim.original_source || claim.claim_date) && (
        <div className="verify-claim-origin">
          {claim.original_source && <span className="verify-claim-origin-source">Source: {claim.original_source}</span>}
          {claim.claim_date && <span className="verify-claim-origin-date">Reported: {claim.claim_date}</span>}
        </div>
      )}
      <ConfidenceBar score={claim.confidence_score} breakdown={claim.scoring_breakdown} />
      {claim.web_search_summary && (
        <div className="verify-claim-summary"><p>{parseSummary(claim.web_search_summary)}</p></div>
      )}
      {claim.supporting_sources && claim.supporting_sources.length > 0 && (
        <div className="verify-claim-sources verify-claim-sources--supporting">
          <span className="verify-claim-sources-label" style={{ color: "#4ade80" }}>Supporting</span>
          {claim.supporting_sources.map((s: any, i: number) => (
            <div key={i} className="verify-claim-source-item">
              {s.url
                ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="verify-claim-source-name verify-claim-source-link">{s.name}</a>
                : <span className="verify-claim-source-name">{s.name}</span>}
              {(s.excerpt || s.stance) && <span className="verify-claim-source-stance">{s.excerpt || s.stance}</span>}
            </div>
          ))}
        </div>
      )}
      {claim.dissenting_sources && claim.dissenting_sources.length > 0 && (
        <div className="verify-claim-sources verify-claim-sources--dissenting">
          <span className="verify-claim-sources-label" style={{ color: "#f87171" }}>Dissenting</span>
          {claim.dissenting_sources.map((s: any, i: number) => (
            <div key={i} className="verify-claim-source-item">
              {s.url
                ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="verify-claim-source-name verify-claim-source-link">{s.name}</a>
                : <span className="verify-claim-source-name">{s.name}</span>}
              {(s.excerpt || s.stance) && <span className="verify-claim-source-stance">{s.excerpt || s.stance}</span>}
            </div>
          ))}
        </div>
      )}
      {claim.framing_analysis && (
        <div className="verify-claim-framing">
          <span className="verify-claim-framing-label">Framing Analysis</span>
          <p>{claim.framing_analysis}</p>
        </div>
      )}
      {claim.investigation && <InvestigationSection inv={claim.investigation} />}
      {claim.evidence_urls && claim.evidence_urls.length > 0 && (
        <div className="verify-claim-evidence">
          <span className="verify-claim-evidence-label">Evidence:</span>
          {claim.evidence_urls.map((url, i) => {
            let hostname = url;
            try { hostname = new URL(url).hostname.replace("www.", ""); } catch {}
            return (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="verify-claim-evidence-link">{hostname}</a>
            );
          })}
        </div>
      )}
      <div className="verify-claim-footer">
        {claim.verified_at ? (
          <span className="verify-claim-date">Verified: {new Date(claim.verified_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
        ) : claim.created_at ? (
          <span className="verify-claim-date" style={{ color: "#64748b" }}>Observed: {new Date(claim.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
        ) : null}
        {claim.tweet_url && (
          <a href={claim.tweet_url} target="_blank" rel="noopener noreferrer" className="verify-claim-tweet">View tweet</a>
        )}
        {claim.category && (
          <span className="verify-claim-category">{claim.category.replace(/_/g, " ")}</span>
        )}
        <CopyLinkButton url={`/veritas-lens#${claim.claim_id}`} />
      </div>
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────
export default function ClaimsSearch({ claims }: { claims: VerifiedClaim[] }) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("all");

  const tagCounts = useMemo(
    () => TAG_ORDER.reduce((acc, tag) => { acc[tag] = claims.filter((c) => deriveTag(c) === tag).length; return acc; }, {} as Record<string, number>),
    [claims],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let result = activeTag === "all" ? claims : claims.filter((c) => deriveTag(c) === activeTag);
    if (q) {
      result = result.filter((c) => {
        const tagLabel = TAG_LABELS[deriveTag(c)]?.toLowerCase() ?? "";
        return c.claim_text.toLowerCase().includes(q) || tagLabel.includes(q);
      });
    }
    return [...result].sort((a, b) => {
      const aDate = a.verified_at ?? a.created_at;
      const bDate = b.verified_at ?? b.created_at;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });
  }, [claims, query, activeTag]);

  const showGrouped = !query.trim() && activeTag === "all";

  const grouped = useMemo(() => {
    if (!showGrouped) return {} as Record<string, VerifiedClaim[]>;
    return TAG_ORDER.reduce((acc, tag) => {
      const items = filtered.filter((c) => deriveTag(c) === tag);
      if (items.length > 0) acc[tag] = items;
      return acc;
    }, {} as Record<string, VerifiedClaim[]>);
  }, [filtered, showGrouped]);

  return (
    <>
      {/* Search */}
      <div className="verify-search-row">
        <div className="verify-search-wrap">
          <svg className="verify-search-icon" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="9" r="7" /><line x1="15" y1="15" x2="19" y2="19" />
          </svg>
          <input
            className="verify-search-input"
            type="search"
            placeholder="Search claims or topics…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {query && (
            <button className="verify-search-clear" onClick={() => setQuery("")} aria-label="Clear search">×</button>
          )}
        </div>
      </div>

      {/* Topic pills */}
      <div className="verify-tag-filters">
        <button
          className={`verify-tag-tab${activeTag === "all" ? " verify-tag-tab--active" : ""}`}
          onClick={() => setActiveTag("all")}
        >
          All topics
        </button>
        {TAG_ORDER.filter((tag) => tagCounts[tag] > 0).map((tag) => (
          <button
            key={tag}
            className={`verify-tag-tab${activeTag === tag ? " verify-tag-tab--active" : ""}`}
            onClick={() => setActiveTag(tag)}
          >
            {TAG_LABELS[tag]}
            <span className="verify-filter-count">{tagCounts[tag]}</span>
          </button>
        ))}
      </div>

      {/* Results */}
      {query.trim() && (
        <p className="verify-search-meta">
          {filtered.length} {filtered.length === 1 ? "result" : "results"} for &ldquo;{query.trim()}&rdquo;
        </p>
      )}

      {showGrouped ? (
        <div className="verify-grouped">
          {TAG_ORDER.filter((tag) => grouped[tag]).map((tag) => (
            <div key={tag} className="verify-topic-group">
              <div className="verify-topic-header">
                <h3 className="verify-topic-label">{TAG_LABELS[tag]}</h3>
                <button className="verify-topic-see-all" onClick={() => setActiveTag(tag)}>
                  {grouped[tag].length} {grouped[tag].length === 1 ? "claim" : "claims"}
                </button>
              </div>
              <div className="verify-claims">
                {grouped[tag].map((claim) => <ClaimCard key={claim.claim_id} claim={claim} />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="verify-claims">
          {filtered.length === 0 && (
            <p className="verify-empty">No claims match your search.</p>
          )}
          {filtered.map((claim) => <ClaimCard key={claim.claim_id} claim={claim} />)}
        </div>
      )}
    </>
  );
}
