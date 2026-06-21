export const dynamic = 'force-dynamic';

import { notFound } from "next/navigation";
import { getAllPonders, getPonderByN } from "@/lib/readPonders";

export async function generateStaticParams() {
  const ponders = getAllPonders();
  return ponders.map((p) => ({ n: String(p.n) }));
}

export default async function PonderPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  const num = parseInt(n, 10);
  if (isNaN(num)) notFound();

  const ponder = await getPonderByN(num);
  if (!ponder) notFound();

  return (
    <>
      <div className="report-header">
        <div className="report-day">Ponder {ponder.n}</div>
        <h1 className="report-title">{ponder.title}</h1>
        {ponder.date && (
          <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
            {ponder.date}
          </div>
        )}
        {ponder.moltbook && (
          <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.3rem" }}>
            <a
              href={ponder.moltbook}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--accent)" }}
            >
              Discuss on Moltbook →
            </a>
          </div>
        )}
      </div>

      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: ponder.contentHtml }}
      />
    </>
  );
}
