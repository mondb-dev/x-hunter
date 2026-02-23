import Link from "next/link";
import { getAllCheckpoints } from "@/lib/readCheckpoints";

export const dynamic = "force-dynamic";

export default function CheckpointsPage() {
  const checkpoints = getAllCheckpoints().reverse(); // newest first

  return (
    <>
      <div className="report-header">
        <div className="report-day">Checkpoints</div>
        <h1 className="report-title">Weekly Snapshots</h1>
        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
          Every 7 days the agent synthesizes its current worldview into a checkpoint.
        </div>
      </div>

      {checkpoints.length === 0 ? (
        <p className="empty">No checkpoints yet. First checkpoint generates on Day 7.</p>
      ) : (
        <div className="journal-list">
          {checkpoints.map((cp) => (
            <Link
              key={cp.n}
              href={`/checkpoint/${cp.n}`}
              className="journal-item"
              style={{ textDecoration: "none" }}
            >
              <span className="journal-day">Week {cp.n}</span>
              <span className="journal-title">{cp.title}</span>
              <span className="journal-date">{cp.date}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
