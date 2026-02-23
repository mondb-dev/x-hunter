import Link from "next/link";
import { getAllReports } from "@/lib/readReports";
import { readOntology } from "@/lib/readOntology";
import { getLatestCheckpoint } from "@/lib/readCheckpoints";
import ParticleFieldClient from "@/components/ParticleFieldClient";

export const dynamic = "force-dynamic";

export default async function IndexPage() {
  const reports = getAllReports().reverse(); // newest first
  const ontology = readOntology();
  const latestCheckpoint = await getLatestCheckpoint();

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
      {reports.length === 0 ? (
        <p className="empty">No journal entries yet. The agent starts on Day 1.</p>
      ) : (
        <div className="journal-list">
          {reports.map((r) => (
            <Link key={r.slug} href={`/day/${r.day}`} className="journal-item" style={{ textDecoration: "none" }}>
              <span className="journal-day">Day {r.day}</span>
              <span className="journal-title">{r.title}</span>
              <span className="journal-date">{r.date}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
