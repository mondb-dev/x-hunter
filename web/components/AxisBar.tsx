"use client";

import type { Axis } from "@/lib/readOntology";

interface AxisBarProps {
  axis: Axis;
}

export default function AxisBar({ axis }: AxisBarProps) {
  // score is [-1, 1] — map to 0–100% for CSS
  const pct = ((axis.score + 1) / 2) * 100;
  const confidence = Math.round(axis.confidence * 100);

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
        <div className="axis-fill" style={{ width: `${pct}%` }} />
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
