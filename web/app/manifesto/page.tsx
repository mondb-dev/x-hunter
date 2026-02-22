import { notFound } from "next/navigation";
import { getManifesto } from "@/lib/readReports";

export const dynamic = "force-dynamic";

export default async function ManifestoPage() {
  const manifesto = await getManifesto();
  if (!manifesto) notFound();

  return (
    <>
      <div className="report-header">
        <div className="report-day">Day 7</div>
        <h1 className="report-title">Manifesto</h1>
        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
          The worldview formed after 7 days of observation.
        </div>
      </div>

      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: manifesto.contentHtml }}
      />
    </>
  );
}
