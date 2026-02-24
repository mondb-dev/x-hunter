import { notFound } from "next/navigation";
import { getAllCheckpoints, getCheckpointByN } from "@/lib/readCheckpoints";


export async function generateStaticParams() {
  const checkpoints = getAllCheckpoints();
  return checkpoints.map((cp) => ({ n: String(cp.n) }));
}

export default async function CheckpointPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  const num = parseInt(n, 10);
  if (isNaN(num)) notFound();

  const checkpoint = await getCheckpointByN(num);
  if (!checkpoint) notFound();

  return (
    <>
      <div className="report-header">
        <div className="report-day">Week {checkpoint.n} — Checkpoint</div>
        <h1 className="report-title">{checkpoint.title}</h1>
        {checkpoint.date && (
          <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
            {checkpoint.date}
          </div>
        )}
      </div>

      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: checkpoint.contentHtml }}
      />
    </>
  );
}
