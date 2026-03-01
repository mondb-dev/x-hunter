import { readOntology } from "@/lib/readOntology";
import AxisBar from "@/components/AxisBar";


export default async function OntologyPage() {
  const ontology = readOntology();
  const axes = ontology.axes;

  const activeAxes   = axes.filter(a => a.confidence > 0).sort((a, b) => b.confidence - a.confidence);
  const inactiveAxes = axes.filter(a => a.confidence <= 0);

  const avgConfidence =
    activeAxes.length > 0
      ? activeAxes.reduce((s, a) => s + a.confidence, 0) / activeAxes.length
      : 0;

  const totalEvidence = axes.reduce((s, a) => s + (a.evidence_log?.length ?? 0), 0);

  return (
    <>
      <div className="ontology-meta">
        <div className="ontology-stat">
          <span className="stat-val">{axes.length}</span>
          <span className="stat-key">Axes</span>
        </div>
        <div className="ontology-stat">
          <span className="stat-val">{activeAxes.length}</span>
          <span className="stat-key">Active</span>
        </div>
        <div className="ontology-stat">
          <span className="stat-val">{totalEvidence}</span>
          <span className="stat-key">Observations</span>
        </div>
        <div className="ontology-stat">
          <span className="stat-val">{Math.round(avgConfidence * 100)}%</span>
          <span className="stat-key">Avg Confidence</span>
        </div>
        <div className="ontology-stat">
          <span className="stat-val">{ontology.last_updated ?? "—"}</span>
          <span className="stat-key">Last Updated</span>
        </div>
      </div>

      {axes.length === 0 ? (
        <p className="empty">No belief axes discovered yet. Check back after Day 3.</p>
      ) : (
        <>
          <div>
            {activeAxes.map((axis) => (
              <AxisBar key={axis.id} axis={axis} />
            ))}
          </div>

          {inactiveAxes.length > 0 && (
            <div className="ontology-seeded">
              <div className="ontology-section-label">Seeded — no observations yet</div>
              {inactiveAxes.map((axis) => (
                <AxisBar key={axis.id} axis={axis} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
