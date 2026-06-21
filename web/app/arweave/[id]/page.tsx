import { notFound } from "next/navigation";

/**
 * /arweave/[id] — renders Arweave content inline, fetched server-side.
 * Avoids sending the browser to gateway.irys.xyz (blocked by MetaMask).
 */

const GATEWAY = "https://gateway.irys.xyz";

export default async function ArweavePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Validate TX ID format (base64url, 43 chars for Arweave, variable for Irys)
  if (!id || !/^[\w\-]{20,80}$/.test(id)) notFound();

  let body: string;
  let contentType: string;
  try {
    const res = await fetch(`${GATEWAY}/${id}`, { next: { revalidate: 86400 } });
    if (!res.ok) notFound();
    contentType = res.headers.get("content-type") ?? "text/plain";
    body = await res.text();
  } catch {
    notFound();
  }

  const isHtml = contentType.includes("html");

  return (
    <>
      <div className="report-header">
        <h1 className="report-title">Arweave Record</h1>
        <div style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "monospace" }}>
          TX: {id}
        </div>
      </div>

      {isHtml ? (
        <div
          className="journal-html-body"
          dangerouslySetInnerHTML={{ __html: body }}
        />
      ) : (
        <pre style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: "13px",
          lineHeight: 1.6,
          color: "var(--fg)",
        }}>
          {body}
        </pre>
      )}
    </>
  );
}
