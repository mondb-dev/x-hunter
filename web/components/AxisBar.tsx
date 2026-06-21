"use client";

import type { Axis } from "@/lib/readOntology";

interface AxisBarProps {
  axis: Axis;
}

function truncatePole(text: string, max = 42): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export default function AxisBar({ axis }: AxisBarProps) {
  const isActive = axis.confidence > 0;
  const evidenceCount = axis.evidence_log?.length ?? 0;
  const confidence = Math.round(axis.confidence * 100);

  // score [-1,+1] → position [0%,100%] on track; 50% = neutral center
  const pct = ((axis.score + 1) / 2) * 100;

  // Fill from center (50%) toward the marker — shows lean direction clearly
  const fillLeft  = axis.score >= 0 ? 50 : pct;
  const fillWidth = Math.abs(pct - 50);
  const fillColor = axis.score > 0
    ? "var(--amber)"
    : axis.score < 0
    ? "var(--accent)"
    : "transparent";

  const scoreStr  = `${axis.score >= 0 ? "+" : ""}${axis.score.toFixed(2)}`;
  const scoreClass = axis.score > 0
    ? "axis-score axis-score-pos"
    : axis.score < 0
    ? "axis-score axis-score-neg"
    : "axis-score axis-score-zero";

  return (
    <div className={`axis-bar${!isActive ? " axis-inactive" : ""}`}>
      <div className="axis-header">
        <span className="axis-label">{axis.label}</span>
        <div className="axis-meta-right">
          <span className={scoreClass}>{scoreStr}</span>
          <span className="axis-confidence">{confidence}% conf</span>
          {evidenceCount > 0 && (
            <span className="axis-obs">{evidenceCount} obs</span>
          )}
        </div>
      </div>

      <div className="axis-poles">
        <span className="pole left">{truncatePole(axis.left_pole)}</span>
        <span className="pole right">{truncatePole(axis.right_pole)}</span>
      </div>

      <div className="axis-track">
        <div className="axis-center-tick" />
        {isActive && (
          <>
            <div
              className="axis-fill"
              style={{ left: `${fillLeft}%`, width: `${fillWidth}%`, background: fillColor }}
            />
            <div className="axis-marker" style={{ left: `${pct}%` }} />
          </>
        )}
        {!isActive && (
          <div className="axis-marker axis-marker-seed" style={{ left: "50%" }} />
        )}
      </div>

      {axis.topics.length > 0 && (
        <div className="axis-topics">
          {axis.topics.map((t) => (
            <span key={t} className="topic-tag">{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}
