import { notFound } from "next/navigation";
import { getAllReports, getReportByDay } from "@/lib/readReports";

export const dynamic = "force-dynamic";

export async function generateStaticParams() {
  const reports = getAllReports();
  return reports.map((r) => ({ n: String(r.day) }));
}

export default async function DayPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  const day = parseInt(n, 10);
  if (isNaN(day)) notFound();

  const report = await getReportByDay(day);
  if (!report) notFound();

  return (
    <>
      <div className="report-header">
        <div className="report-day">Day {report.day}</div>
        <h1 className="report-title">{report.title}</h1>
        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>{report.date}</div>
      </div>

      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: report.contentHtml }}
      />
    </>
  );
}
