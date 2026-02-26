import { readOntology } from "@/lib/readOntology";
import AxisBar from "@/components/AxisBar";


export default async function OntologyPage() {
  const ontology = readOntology();
  const axes = ontology.axes;

  const avgConfidence =
    axes.length > 0
      ? axes.reduce((s, a) => s + a.confidence, 0) / axes.length
      : 0;

  const avgScore =
    axes.length > 0
      ? axes.reduce((s, a) => s + Math.abs(a.score), 0) / axes.length
      : 0;

  return (
    <>
      <div className="ontology-meta">
        <div className="ontology-stat">
          <span className="stat-val">{axes.length}</span>
          <span className="stat-key">Axes</span>
        </div>
        <div className="ontology-stat">
          <span className="stat-val">{Math.round(avgConfidence * 100)}%</span>
          <span className="stat-key">Avg Confidence</span>
        </div>
        <div className="ontology-stat">
          <span className="stat-val">{avgScore.toFixed(2)}</span>
          <span className="stat-key">Avg |Score|</span>
        </div>
        <div className="ontology-stat">
          <span className="stat-val">{ontology.last_updated ?? "—"}</span>
          <span className="stat-key">Last Updated</span>
        </div>
      </div>

      {axes.length === 0 ? (
        <p className="empty">No belief axes discovered yet. Check back after Day 3.</p>
      ) : (
        <div>
          {axes
            .slice()
            .sort((a, b) => b.confidence - a.confidence)
            .map((axis) => (
              <AxisBar key={axis.id} axis={axis} />
            ))}
        </div>
      )}
    </>
  );
}
