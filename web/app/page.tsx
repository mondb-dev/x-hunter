import Link from "next/link";
import { getAllJournalDays } from "@/lib/readJournals";
import { readOntology } from "@/lib/readOntology";
import { getLatestCheckpoint } from "@/lib/readCheckpoints";


export default async function IndexPage() {
  const days = getAllJournalDays(); // newest date first
  const ontology = readOntology();
  const latestCheckpoint = await getLatestCheckpoint();
  const totalEntries = days.reduce((n, d) => n + d.entries.length, 0);

  const top3 = [...ontology.axes]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  const avgConf = ontology.axes.length > 0
    ? Math.round(ontology.axes.reduce((s, a) => s + a.confidence, 0) / ontology.axes.length * 100)
    : 0;

  return (
    <>
      {/* Belief state hero — top 3 axes by confidence */}
      {ontology.axes.length > 0 && (
        <div className="belief-hero">
          <div className="belief-hero-header">
            belief state · {ontology.axes.length} axes · {avgConf}% avg confidence
          </div>
          <div className="belief-axes-mini">
            {top3.map((axis) => {
              const pct       = ((axis.score + 1) / 2) * 100;
              const fillLeft  = Math.min(50, pct);
              const fillWidth = Math.abs(pct - 50);
              const fillColor = axis.score >= 0 ? "var(--amber)" : "var(--accent)";
              const leanPole  = axis.score >= 0 ? axis.right_pole : axis.left_pole;
              const confidence = Math.round(axis.confidence * 100);
              return (
                <div key={axis.id} className="belief-axis-mini">
                  <div className="belief-axis-mini-header">
                    <span className="belief-axis-mini-label">{axis.label}</span>
                    <span className="belief-axis-mini-meta">
                      {axis.score === 0 ? "neutral" : `${axis.score > 0 ? "→" : "←"} ${leanPole}`}
                      {" · "}{confidence}%
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
          <span className="pin-label">Week {latestCheckpoint.n} checkpoint</span>
          <Link href={`/checkpoint/${latestCheckpoint.n}`}>
            Read latest worldview snapshot →
          </Link>
        </div>
      )}

      {/* Journal entries */}
      {totalEntries === 0 ? (
        <p className="empty">No journal entries yet. The agent starts on Day 1.</p>
      ) : (
        <div className="journal-list">
          {days.flatMap((day) =>
            day.entries.map((entry) => (
              <Link
                key={entry.slug}
                href={`/journal/${entry.date}/${String(entry.hour).padStart(2, "0")}`}
                className="journal-item"
                style={{ textDecoration: "none" }}
              >
                <span className="journal-day">Day {entry.day} · {String(entry.hour).padStart(2, "0")}:00</span>
                <span className="journal-title">{entry.title || entry.date}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </>
  );
}
