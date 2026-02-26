"use client";

import type { Axis } from "@/lib/readOntology";

interface AxisBarProps {
  axis: Axis;
}

export default function AxisBar({ axis }: AxisBarProps) {
  // score [-1, 1] → position 0–100% on track (50% = neutral center)
  const pct = ((axis.score + 1) / 2) * 100;
  const confidence = Math.round(axis.confidence * 100);

  // Fill extends from center (50%) to marker — direction shows which pole dominates
  const fillLeft  = Math.min(50, pct);
  const fillWidth = Math.abs(pct - 50);
  const fillColor = axis.score >= 0 ? "var(--amber)" : "var(--accent)";

  return (
    <div className="axis-bar">
      <div className="axis-header">
        <span className="axis-label">{axis.label}</span>
        <span className="axis-confidence">{confidence}% confidence</span>
      </div>

      <div className="axis-poles">
        <span className="pole left">{axis.left_pole}</span>
        <span className="pole right">{axis.right_pole}</span>
      </div>

      <div className="axis-track">
        <div className="axis-center-tick" />
        <div className="axis-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%`, background: fillColor }} />
        <div className="axis-marker" style={{ left: `${pct}%` }} />
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
