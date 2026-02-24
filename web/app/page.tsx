import Link from "next/link";
import { getAllJournalDays } from "@/lib/readJournals";
import { readOntology } from "@/lib/readOntology";
import { getLatestCheckpoint } from "@/lib/readCheckpoints";
import ParticleFieldClient from "@/components/ParticleFieldClient";


export default async function IndexPage() {
  const days = getAllJournalDays(); // newest date first
  const ontology = readOntology();
  const latestCheckpoint = await getLatestCheckpoint();
  const totalEntries = days.reduce((n, d) => n + d.entries.length, 0);

  return (
    <>
      {/* Particle hero — driven by current belief state */}
      <div className="hero">
        <div className="hero-canvas">
          <ParticleFieldClient axes={ontology.axes} />
        </div>
        <span className="hero-label">
          {ontology.axes.length === 0
            ? "day 0 — no beliefs formed yet"
            : `${ontology.axes.length} belief axes active`}
        </span>
      </div>

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
                <span className="journal-date">{entry.date}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </>
  );
}
