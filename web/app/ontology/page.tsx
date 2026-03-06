import { readOntology, type Axis } from "@/lib/readOntology";
import AxisBar from "@/components/AxisBar";
import BeliefMap, { type MapNode, type MapEdge } from "@/components/BeliefMap";

function buildGraph(axes: Axis[]): { nodes: MapNode[]; edges: MapEdge[] } {
  const nodes: MapNode[] = axes
    .filter(a => a.confidence > 0)
    .map(a => ({
      id: a.id,
      label: a.label,
      score: a.score,
      confidence: a.confidence,
      evidenceCount: a.evidence_log?.length ?? 0,
      leftPole: a.left_pole,
      rightPole: a.right_pole,
    }));

  const handleSets = axes.map(a => {
    const handles = new Set<string>();
    for (const ev of (a.evidence_log ?? [])) {
      const m = (ev.source ?? "").match(/x\.com\/([A-Za-z0-9_]+)\/status\//);
      if (m) handles.add(m[1].toLowerCase());
    }
    return { id: a.id, handles };
  });

  const edges: MapEdge[] = [];
  for (let i = 0; i < handleSets.length; i++) {
    for (let j = i + 1; j < handleSets.length; j++) {
      const shared = [...handleSets[i].handles].filter(h => handleSets[j].handles.has(h)).length;
      if (shared >= 2) edges.push({ source: handleSets[i].id, target: handleSets[j].id, weight: shared });
    }
  }
  return { nodes, edges };
}

export default async function OntologyPage() {
  const ontology = readOntology();
  const axes = ontology.axes;
  const { nodes, edges } = buildGraph(axes);

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
          {nodes.length > 0 && (
            <div style={{ margin: "1.5rem 0", border: "1px solid #1e2022", padding: "0.75rem 0.5rem 0.5rem" }}>
              <div style={{ fontSize: "10px", color: "#8b99aa", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.5rem", paddingLeft: "0.5rem" }}>
                belief map · hover to explore · lines = shared evidence sources
              </div>
              <BeliefMap nodes={nodes} edges={edges} />
            </div>
          )}

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
