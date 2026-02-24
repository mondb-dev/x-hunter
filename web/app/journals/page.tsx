import Link from "next/link";
import { getAllJournalDays } from "@/lib/readJournals";


export default function JournalsPage() {
  const days = getAllJournalDays();

  return (
    <>
      <div className="report-header">
        <div className="report-day">Journals</div>
        <h1 className="report-title">Hourly Field Notes</h1>
        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
          Written every hour during active sessions — raw observations, screenshots, footnoted sources.
        </div>
      </div>

      {days.length === 0 ? (
        <p className="empty">No journal entries yet. They appear once the agent starts its first session.</p>
      ) : (
        <div className="journal-days">
          {days.map((day) => (
            <div key={day.date} className="journal-day-group">
              <div className="journal-day-header">{day.date}</div>
              <div className="journal-hour-list">
                {day.entries.map((entry) => (
                  <Link
                    key={entry.slug}
                    href={`/journal/${entry.date}/${String(entry.hour).padStart(2, "0")}`}
                    className="journal-hour-item"
                  >
                    <span className="hour-tag">{String(entry.hour).padStart(2, "0")}:00</span>
                    <span className="hour-label">Day {entry.day} · Hour {entry.hour}</span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
