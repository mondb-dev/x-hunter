import { notFound } from "next/navigation";
import Link from "next/link";
import { getAllJournalDays, getJournalEntry } from "@/lib/readJournals";


export async function generateStaticParams() {
  const days = getAllJournalDays();
  return days.flatMap((d) =>
    d.entries.map((e) => ({
      date: e.date,
      hour: String(e.hour).padStart(2, "0"),
    }))
  );
}

export default async function JournalEntryPage({
  params,
}: {
  params: Promise<{ date: string; hour: string }>;
}) {
  const { date, hour } = await params;
  const hourNum = parseInt(hour, 10);
  if (isNaN(hourNum)) notFound();

  const entry = getJournalEntry(date, hourNum);
  if (!entry) notFound();

  // Find actual adjacent entries (not just ±1 hour — those files may not exist)
  const allEntries = getAllJournalDays()
    .flatMap((d) => d.entries)
    .sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
  const idx = allEntries.findIndex((e) => e.date === date && e.hour === hourNum);
  const prevEntry = idx > 0 ? allEntries[idx - 1] : null;
  const nextEntry = idx < allEntries.length - 1 ? allEntries[idx + 1] : null;
  const prevHref = prevEntry ? `/journal/${prevEntry.date}/${String(prevEntry.hour).padStart(2, "0")}` : null;
  const nextHref = nextEntry ? `/journal/${nextEntry.date}/${String(nextEntry.hour).padStart(2, "0")}` : null;
  const prevLabel = prevEntry ? `← ${String(prevEntry.hour).padStart(2, "0")}:00` : null;
  const nextLabel = nextEntry ? `${String(nextEntry.hour).padStart(2, "0")}:00 →` : null;

  return (
    <>
      <div className="report-header">
        <div className="report-day">Day {entry.day} · {date}</div>
        <h1 className="report-title">{String(hourNum).padStart(2, "0")}:00 Field Notes</h1>
        <div className="journal-nav">
          {prevHref && <Link href={prevHref}>{prevLabel}</Link>}
          <Link href="/journals" style={{ margin: "0 1rem", color: "var(--muted)" }}>
            all entries
          </Link>
          {nextHref && <Link href={nextHref}>{nextLabel}</Link>}
          {entry.arweaveUrl && (
            <a
              href={entry.arweaveUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: "auto", fontSize: "11px", color: "var(--muted)", fontFamily: "monospace" }}
              title="Permanent copy on Arweave"
            >
              ∞ arweave
            </a>
          )}
        </div>
      </div>

      <div
        className="journal-html-body"
        dangerouslySetInnerHTML={{ __html: entry.contentHtml }}
      />
    </>
  );
}
