import Link from "next/link";
import { getAllJournalDays } from "@/lib/readJournals";


export default function JournalsPage() {
  const days = getAllJournalDays();
  const totalEntries = days.reduce((n, d) => n + d.entries.length, 0);

  return (
    <>
      <div className="report-header">
        <div className="report-day">Journals · {totalEntries} entries</div>
        <h1 className="report-title">Hourly Field Notes</h1>
        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
          Written every hour during active sessions — raw observations, footnoted sources.
        </div>
      </div>

      {totalEntries === 0 ? (
        <p className="empty">No journal entries yet. They appear once the agent starts its first session.</p>
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
                <span className="journal-date">{entry.date}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </>
  );
}
