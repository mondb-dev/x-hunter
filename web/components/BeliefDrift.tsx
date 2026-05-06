"use client";

import { useState } from "react";

export interface DriftSample {
  week: string;
  score: number;
}

export interface DriftAxis {
  id: string;
  label: string;
  current_score: number;
  confidence: number;
  evidence_count: number;
  samples: DriftSample[];
}

export interface BeliefDriftProps {
  axes: DriftAxis[];
}

const COLORS = [
  "#f59e0b", "#3b82f6", "#10b981", "#ef4444",
  "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
];

const W = 680;
const H = 280;
const ML = 44, MR = 16, MT = 20, MB = 42;
const cW = W - ML - MR;
const cH = H - MT - MB;

function yp(v: number): number {
  return MT + (1 - (v + 1) / 2) * cH;
}

const Y_TICKS = [-1, -0.5, 0, 0.5, 1];

export default function BeliefDrift({ axes }: BeliefDriftProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltipPt, setTooltipPt] = useState<{ x: number; y: number; label: string; score: number } | null>(null);

  if (!axes || axes.length === 0) return null;

  // Merge all week labels across axes for a common x-axis
  const allWeeks = Array.from(
    new Set(axes.flatMap(a => a.samples.map(s => s.week)))
  ).sort();

  if (allWeeks.length < 2) return null;

  function xp(weekIdx: number): number {
    return ML + (weekIdx / (allWeeks.length - 1)) * cW;
  }

  // X label step — avoid crowding
  const xStep = Math.max(1, Math.ceil(allWeeks.length / 9));

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        aria-label="Belief drift over time"
      >
        {/* Y grid */}
        {Y_TICKS.map(v => {
          const y = yp(v);
          const isZero = v === 0;
          return (
            <g key={v}>
              <line
                x1={ML} y1={y} x2={ML + cW} y2={y}
                stroke={isZero ? "#252830" : "#191b1e"}
                strokeWidth={isZero ? 1.2 : 0.7}
                strokeDasharray={isZero ? "4 3" : "2 4"}
              />
              <text x={ML - 4} y={y + 3} fontSize={7} fill="#4a5568" textAnchor="end">
                {v >= 0 ? "+" : ""}{v.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* X labels */}
        {allWeeks.map((w, i) => {
          if (i % xStep !== 0 && i !== allWeeks.length - 1) return null;
          return (
            <text key={w} x={xp(i)} y={MT + cH + 12} fontSize={7} fill="#4a5568" textAnchor="middle">
              {w.slice(5)}
            </text>
          );
        })}

        {/* Bottom frame line */}
        <line x1={ML} y1={MT + cH} x2={ML + cW} y2={MT + cH} stroke="#252830" strokeWidth={0.8} />

        {/* Series */}
        {axes.map((axis, si) => {
          const color = COLORS[si % COLORS.length];
          const isHov = hovered === axis.id;
          const dimmed = hovered !== null && !isHov;

          // Map samples onto the common week scale
          const sampleMap = new Map(axis.samples.map(s => [s.week, s.score]));
          const pts: { x: number; y: number; score: number }[] = [];
          allWeeks.forEach((w, i) => {
            if (sampleMap.has(w)) {
              pts.push({ x: xp(i), y: yp(sampleMap.get(w)!), score: sampleMap.get(w)! });
            }
          });

          if (pts.length < 2) return null;

          const polyPts = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
          const lastPt = pts[pts.length - 1];

          return (
            <g
              key={axis.id}
              onMouseEnter={() => setHovered(axis.id)}
              onMouseLeave={() => { setHovered(null); setTooltipPt(null); }}
              style={{ cursor: "pointer" }}
            >
              <polyline
                points={polyPts}
                fill="none"
                stroke={color}
                strokeWidth={isHov ? 2.2 : 1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={dimmed ? 0.12 : isHov ? 1 : 0.75}
              />
              {/* Hover hit area */}
              <polyline
                points={polyPts}
                fill="none"
                stroke="transparent"
                strokeWidth={10}
              />
              {/* Terminal dot */}
              <circle
                cx={lastPt.x} cy={lastPt.y} r={isHov ? 3.5 : 2.5}
                fill={color}
                opacity={dimmed ? 0.12 : 0.9}
                onMouseMove={(e) => {
                  const svg = (e.target as SVGElement).closest("svg")!;
                  const rect = svg.getBoundingClientRect();
                  const pxX = e.clientX - rect.left;
                  const pxXNorm = pxX / rect.width;
                  // find nearest sample point
                  let nearest = pts[0];
                  let minDist = Infinity;
                  pts.forEach(p => {
                    const d = Math.abs(p.x / W - pxXNorm);
                    if (d < minDist) { minDist = d; nearest = p; }
                  });
                  setTooltipPt({ x: pxXNorm * 100, y: (nearest.y / H) * 100, label: axis.label, score: nearest.score });
                }}
              />
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "6px 14px",
        marginTop: "4px",
        paddingLeft: "2px",
      }}>
        {axes.map((axis, si) => {
          const color = COLORS[si % COLORS.length];
          const isHov = hovered === axis.id;
          const dimmed = hovered !== null && !isHov;
          const score = axis.current_score;
          const scoreStr = `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
          return (
            <div
              key={axis.id}
              onMouseEnter={() => setHovered(axis.id)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                cursor: "pointer",
                opacity: dimmed ? 0.28 : 1,
                transition: "opacity 0.15s",
              }}
            >
              <div style={{
                width: 10, height: 2.5, background: color,
                borderRadius: 2, flexShrink: 0,
              }} />
              <span style={{ fontSize: 10, color: "#8b99aa", lineHeight: 1.2 }}>
                {axis.label.replace(/^(The |A |An )/, "").split(" ").slice(0, 4).join(" ")}
              </span>
              <span style={{ fontSize: 10, color, fontWeight: 700 }}>{scoreStr}</span>
            </div>
          );
        })}
      </div>

      {/* Hover tooltip */}
      {tooltipPt && (
        <div style={{
          position: "absolute",
          left: tooltipPt.x > 60 ? undefined : `${tooltipPt.x + 1}%`,
          right: tooltipPt.x > 60 ? `${100 - tooltipPt.x + 1}%` : undefined,
          top: tooltipPt.y > 60 ? undefined : `${tooltipPt.y + 1}%`,
          bottom: tooltipPt.y > 60 ? `${100 - tooltipPt.y + 2}%` : undefined,
          background: "#111214",
          border: "1px solid #1e2022",
          padding: "5px 9px",
          fontSize: 10,
          lineHeight: 1.5,
          pointerEvents: "none",
          zIndex: 20,
        }}>
          <div style={{ color: "#e8eaed", fontWeight: 700 }}>{tooltipPt.label}</div>
          <div style={{ color: "#8b99aa" }}>
            score: <span style={{ color: tooltipPt.score > 0.08 ? "#f59e0b" : tooltipPt.score < -0.08 ? "#3b82f6" : "#8b99aa", fontWeight: 700 }}>
              {tooltipPt.score >= 0 ? "+" : ""}{tooltipPt.score.toFixed(3)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
