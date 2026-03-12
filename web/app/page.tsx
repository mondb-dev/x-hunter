import Link from "next/link";
import { getAllJournalDays } from "@/lib/readJournals";
import { readOntology, type Axis } from "@/lib/readOntology";
import { getLatestCheckpoint } from "@/lib/readCheckpoints";
import LatestPost from "@/components/LatestPost";
import BeliefMap, { type MapNode, type MapEdge } from "@/components/BeliefMap";

function buildGraph(axes: Axis[]): { nodes: MapNode[]; edges: MapEdge[] } {
  const nodes: MapNode[] = axes
    .filter(a => a.confidence > 0)
    .map(a => ({
      id: a.id,
      label: a.label,
      score: a.score,
      confidence: a.confidence,
      evidenceCount: a.evidence_log?.length ?? 0,
      leftPole: a.left_pole,
      rightPole: a.right_pole,
    }));
  const handleSets = axes.map(a => {
    const handles = new Set<string>();
    for (const ev of (a.evidence_log ?? [])) {
      const m = (ev.source ?? "").match(/x\.com\/([A-Za-z0-9_]+)\/status\//);
      if (m) handles.add(m[1].toLowerCase());
    }
    return { id: a.id, handles };
  });
  const edges: MapEdge[] = [];
  for (let i = 0; i < handleSets.length; i++) {
    for (let j = i + 1; j < handleSets.length; j++) {
      const shared = [...handleSets[i].handles].filter(h => handleSets[j].handles.has(h)).length;
      if (shared >= 2) edges.push({ source: handleSets[i].id, target: handleSets[j].id, weight: shared });
    }
  }
  return { nodes, edges };
}

export const dynamic = "force-dynamic";

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

    const { nodes: mapNodes, edges: mapEdges } = buildGraph(ontology.axes);

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

        {/* Belief map */}
        {mapNodes.length > 0 && (
          <div className="belief-hero">
            <div className="belief-hero-header">
              belief state · {ontology.axes.length} axes · {avgConf}% avg confidence
              <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: "10px", marginLeft: "0.5rem" }}>
                x = lean · y = certainty · size = evidence · lines = shared sources
              </span>
            </div>
            <BeliefMap nodes={mapNodes} edges={mapEdges} compact />
            <Link href="/ontology" className="belief-hero-link">explore full belief system →</Link>
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
    return (
      <p className="empty">
        Loading... if this persists, check back shortly.
      </p>
    );
  }
}
