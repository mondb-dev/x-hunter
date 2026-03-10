import Link from "next/link";
import { getAllPonders } from "@/lib/readPonders";

export default function PondersPage() {
  const ponders = getAllPonders().reverse(); // newest first

  return (
    <>
      <div className="report-header">
        <div className="report-day">Ponders</div>
        <h1 className="report-title">Compulsion &amp; Vocation</h1>
        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
          When enough belief axes reach conviction threshold, the agent stops and asks: what am I
          actually called to do? These are the results of those moments.
        </div>
      </div>

      {ponders.length === 0 ? (
        <p className="empty">No ponders yet. First ponder fires when conviction thresholds are met.</p>
      ) : (
        <div className="journal-list">
          {ponders.map((p) => (
            <Link
              key={p.n}
              href={`/ponders/${p.n}`}
              className="journal-item"
              style={{ textDecoration: "none" }}
            >
              <span className="journal-day">Ponder {p.n}</span>
              <span className="journal-title">
                {p.vocation
                  ? `"${p.vocation.length > 90 ? p.vocation.slice(0, 87) + "..." : p.vocation}"`
                  : p.title}
              </span>
              <span className="journal-date">{p.date}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
