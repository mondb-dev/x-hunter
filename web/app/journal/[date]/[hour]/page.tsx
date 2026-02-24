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

  // Adjacent hours for prev/next navigation
  const prevHour = hourNum > 0 ? String(hourNum - 1).padStart(2, "0") : null;
  const nextHour = hourNum < 23 ? String(hourNum + 1).padStart(2, "0") : null;

  return (
    <>
      <div className="report-header">
        <div className="report-day">Day {entry.day} · {date}</div>
        <h1 className="report-title">{String(hourNum).padStart(2, "0")}:00 Field Notes</h1>
        <div className="journal-nav">
          {prevHour && (
            <Link href={`/journal/${date}/${prevHour}`}>← {prevHour}:00</Link>
          )}
          <Link href="/journals" style={{ margin: "0 1rem", color: "var(--muted)" }}>
            all entries
          </Link>
          {nextHour && (
            <Link href={`/journal/${date}/${nextHour}`}>{nextHour}:00 →</Link>
          )}
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
