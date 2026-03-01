import Link from "next/link";
import { getAllJournalDays } from "@/lib/readJournals";
import { readOntology } from "@/lib/readOntology";
import { getLatestCheckpoint } from "@/lib/readCheckpoints";
import LatestPost from "@/components/LatestPost";

const PAGE_SIZE = 15;

export default async function IndexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  try {
    const params = await searchParams;
    const currentPage = Math.max(1, parseInt(params?.page ?? "1", 10));

    const days = getAllJournalDays(); // newest date first
    const ontology = readOntology();
    const latestCheckpoint = await getLatestCheckpoint();

    const top3 = [...ontology.axes]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    const avgConf = ontology.axes.length > 0
      ? Math.round(ontology.axes.reduce((s, a) => s + a.confidence, 0) / ontology.axes.length * 100)
      : 0;

    // Flatten all entries for pagination
    const allEntries = days.flatMap((day) => day.entries);
    const totalEntries = allEntries.length;
    const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
    const page = Math.min(currentPage, totalPages);
    const pageEntries = allEntries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    return (
      <>
        {/* Latest post from X */}
        <LatestPost />

        {/* Belief state hero — top 3 axes by confidence */}
        {ontology.axes.length > 0 && (
          <div className="belief-hero">
            <div className="belief-hero-header">
              belief state · {ontology.axes.length} axes · {avgConf}% avg confidence
            </div>
            <div className="belief-axes-mini">
              {top3.map((axis) => {
                const pct        = ((axis.score + 1) / 2) * 100;
                const fillLeft   = axis.score >= 0 ? 50 : pct;
                const fillWidth  = Math.abs(pct - 50);
                const fillColor  = axis.score > 0 ? "var(--amber)" : axis.score < 0 ? "var(--accent)" : "transparent";
                const scoreStr   = `${axis.score >= 0 ? "+" : ""}${axis.score.toFixed(2)}`;
                const scoreColor = axis.score > 0 ? "var(--amber)" : axis.score < 0 ? "var(--accent)" : "var(--muted)";
                const confidence = Math.round(axis.confidence * 100);
                return (
                  <div key={axis.id} className="belief-axis-mini">
                    <div className="belief-axis-mini-header">
                      <span className="belief-axis-mini-label">{axis.label}</span>
                      <span className="belief-axis-mini-meta">
                        <span style={{ color: scoreColor, fontWeight: 700 }}>{scoreStr}</span>
                        {" · "}{confidence}% conf
                      </span>
                    </div>
                    <div className="belief-mini-track">
                      <div className="belief-mini-tick" />
                      <div className="belief-mini-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%`, background: fillColor }} />
                      <div className="belief-mini-marker" style={{ left: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <Link href="/ontology" className="belief-hero-link">all axes →</Link>
          </div>
        )}

        {/* Latest checkpoint pin */}
        {latestCheckpoint && (
          <div className="manifesto-pin">
            <span className="pin-label">Checkpoint {latestCheckpoint.n}</span>
            <Link href={`/checkpoint/${latestCheckpoint.n}`}>
              Read latest worldview snapshot →
            </Link>
          </div>
        )}

        {/* Journal entries */}
        {totalEntries === 0 ? (
          <p className="empty">No journal entries yet. The agent starts on Day 1.</p>
        ) : (
          <>
            <div className="journal-list">
              {pageEntries.map((entry) => (
                <Link
                  key={entry.slug}
                  href={`/journal/${entry.date}/${String(entry.hour).padStart(2, "0")}`}
                  className="journal-item"
                  style={{ textDecoration: "none" }}
                >
                  <span className="journal-day">Day {entry.day} · {String(entry.hour).padStart(2, "0")}:00</span>
                  <span className="journal-title">{entry.title || entry.date}</span>
                </Link>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="pagination">
                {page > 1 ? (
                  <Link href={`/?page=${page - 1}`} className="pagination-btn">← newer</Link>
                ) : (
                  <span className="pagination-btn pagination-disabled">← newer</span>
                )}
                <span className="pagination-info">page {page} of {totalPages}</span>
                {page < totalPages ? (
                  <Link href={`/?page=${page + 1}`} className="pagination-btn">older →</Link>
                ) : (
                  <span className="pagination-btn pagination-disabled">older →</span>
                )}
              </div>
            )}
          </>
        )}
      </>
    );
  } catch (err) {
    console.error("[IndexPage] render failed:", err);
    // Fallback: show plain journal list without dynamic data
    return (
      <p className="empty">
        Loading... if this persists, check back shortly.
      </p>
    );
  }
}
