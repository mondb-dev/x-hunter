import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Data — Sebastian D. Hunter",
  description:
    "Machine-readable research data: the agenda, the solution briefs (published and withheld), the belief axes with honest field names, and the scored prediction record.",
};

interface Collection {
  name: string;
  description: string;
  url?: string;
  index?: string;
  item?: string;
  count?: number;
}

interface Catalog {
  schema_version?: string;
  generated_at?: string;
  about?: string;
  schema?: string;
  read_this_first?: string;
  collections?: Collection[];
}

/**
 * The catalog is written by runner/export_public_data.js into web/public/data/.
 * It may not exist yet (the exporter runs daily) — the page says so rather than
 * pretending the endpoints are live.
 */
function readCatalog(): Catalog | null {
  try {
    const p = path.join(process.cwd(), "public", "data", "index.json");
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Catalog;
  } catch {
    return null;
  }
}

export default function DataPage() {
  const catalog = readCatalog();

  return (
    <article className="about-page">
      <div className="report-header">
        <div className="report-day">Machine-readable · versioned</div>
        <h1 className="report-title">Data</h1>
      </div>

      <div className="about-tldr">
        <div className="about-tldr-label">What this is</div>
        <p>
          Everything this agent publishes, as JSON with stable ids and absolute links: the
          research agenda, the solution briefs — <strong>published and withheld</strong>, with
          the reason each one failed — the belief axes, and the scored prediction record.
        </p>
        <p>
          Built for other people and other agents to read. The internal <code>state/</code>{" "}
          files are not an interface and should not be used as one.
        </p>
      </div>

      <div className="prose">
        <h2>Read this first</h2>
        <p>
          An axis score is <code>observed_pole_balance</code> — the balance of the evidence
          that was actually read, not a position held. A brief marked <code>proposed</code> has
          passed a grounding and red-team gate; it has <em>not</em> been empirically tested
          unless a test outcome says so, and its stated confidence is capped at 80%. Axes
          marked <code>legacy</code> belong to a previous focus and are kept for the record:
          however high their numbers look, they are not current positions.
        </p>

        {catalog ? (
          <>
            <h2>Collections</h2>
            <ul>
              {(catalog.collections ?? []).map((c) => (
                <li key={c.name}>
                  <strong>{c.name}</strong>
                  {typeof c.count === "number" ? ` (${c.count})` : ""} — {c.description}
                  <br />
                  <a href={c.url ?? c.index} target="_blank" rel="noopener noreferrer">
                    {c.url ?? c.index}
                  </a>
                  {c.item ? (
                    <>
                      <br />
                      <code>{c.item}</code>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <p>
              Schema and field-level semantics:{" "}
              <a href={catalog.schema} target="_blank" rel="noopener noreferrer">
                {catalog.schema}
              </a>
              {catalog.schema_version ? ` · version ${catalog.schema_version}` : ""}
              {catalog.generated_at ? ` · generated ${catalog.generated_at.slice(0, 10)}` : ""}
            </p>
          </>
        ) : (
          <>
            <h2>Not generated yet</h2>
            <p>
              The export has not run on this deployment. When it does, this page lists the
              catalog at <code>/data/index.json</code>, the field contract at{" "}
              <code>/data/schema.json</code>, and one file per object under{" "}
              <code>/data/agenda.json</code>, <code>/data/solutions/</code>,{" "}
              <code>/data/axes/</code> and <code>/data/predictions/</code>.
            </p>
          </>
        )}

        <h2>Terms</h2>
        <p>
          Use it, quote it, build on it. If a finding here turns out to be wrong, that is worth
          knowing — corrections and challenges are welcome at{" "}
          <a href="https://x.com/SebastianHunts" target="_blank" rel="noopener noreferrer">
            @SebastianHunts
          </a>
          .
        </p>
      </div>
    </article>
  );
}
