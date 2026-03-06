"use client";

import { useState } from "react";

export interface MapNode {
  id: string;
  label: string;
  score: number;
  confidence: number;
  evidenceCount: number;
  leftPole: string;
  rightPole: string;
}

export interface MapEdge {
  source: string;
  target: string;
  weight: number;
}

interface BeliefMapProps {
  nodes: MapNode[];
  edges: MapEdge[];
  compact?: boolean;
}

const W = 600;

function scoreToX(score: number): number {
  return 44 + ((score + 1) / 2) * (W - 88);
}

function confToY(conf: number, H: number): number {
  return 28 + (1 - conf) * (H - 52);
}

function nodeRadius(evidenceCount: number): number {
  return Math.min(18, 5 + Math.sqrt(evidenceCount) * 1.4);
}

function nodeColor(score: number, confidence: number): string {
  if (confidence < 0.08) return "#8b99aa"; // --muted
  if (score > 0.08)  return "#f59e0b"; // --amber
  if (score < -0.08) return "#3b82f6"; // --accent
  return "#8b99aa"; // --muted
}

// Deterministic jitter to break up overlapping nodes
function jitter(id: string, axis: "x" | "y"): number {
  let h = axis === "x" ? 0x811c9dc5 : 0x84222325;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return ((h % 10000) / 10000 - 0.5) * 22;
}

export default function BeliefMap({ nodes, edges, compact = false }: BeliefMapProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const H = compact ? 250 : 370;

  const positions = new Map(
    nodes.map(n => [
      n.id,
      {
        x: Math.max(30, Math.min(W - 30, scoreToX(n.score) + jitter(n.id, "x"))),
        y: Math.max(18, Math.min(H - 18, confToY(n.confidence, H) + jitter(n.id, "y"))),
      },
    ])
  );

  const maxWeight = Math.max(1, ...edges.map(e => e.weight));
  const hoveredNode = nodes.find(n => n.id === hovered) ?? null;

  const connectedIds = new Set(
    hovered
      ? edges
          .filter(e => e.source === hovered || e.target === hovered)
          .flatMap(e => [e.source, e.target])
      : []
  );

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        aria-label="Belief position map"
      >
        {/* Grid lines */}
        <line x1={W / 2} y1={8} x2={W / 2} y2={H - 8}
          stroke="#1e2022" strokeWidth="1" strokeDasharray="3 5" />
        <line x1={32} y1={H / 2} x2={W - 32} y2={H / 2}
          stroke="#1e2022" strokeWidth="1" strokeDasharray="3 5" />

        {/* Quadrant labels */}
        <text x={38} y={18} fontSize="8" fill="#8b99aa" opacity="0.5">← left pole</text>
        <text x={W - 38} y={18} fontSize="8" fill="#8b99aa" opacity="0.5" textAnchor="end">right pole →</text>
        <text x={W / 2 + 5} y={H - 6} fontSize="8" fill="#8b99aa" opacity="0.5">forming</text>
        <text x={W / 2 + 5} y={16} fontSize="8" fill="#8b99aa" opacity="0.5">confident</text>

        {/* Edges */}
        {edges.map((edge, i) => {
          const src = positions.get(edge.source);
          const tgt = positions.get(edge.target);
          if (!src || !tgt) return null;
          const isHighlighted = hovered === edge.source || hovered === edge.target;
          const baseOpacity = 0.06 + (edge.weight / maxWeight) * 0.16;
          return (
            <line
              key={i}
              x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
              stroke={isHighlighted ? "#e8eaed" : "#8b99aa"}
              strokeWidth={isHighlighted ? 1.5 : 0.8}
              opacity={isHighlighted ? 0.45 : (hovered ? baseOpacity * 0.4 : baseOpacity)}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map(node => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          const r = nodeRadius(node.evidenceCount);
          const color = nodeColor(node.score, node.confidence);
          const isHovered = hovered === node.id;
          const isConnected = connectedIds.has(node.id);
          const dim = hovered !== null && !isHovered && !isConnected;

          return (
            <g
              key={node.id}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: "pointer" }}
            >
              {/* Glow ring on hover */}
              {isHovered && (
                <circle cx={pos.x} cy={pos.y} r={r + 6}
                  fill="none" stroke={color} strokeWidth="1" opacity="0.25" />
              )}
              <circle
                cx={pos.x} cy={pos.y} r={isHovered ? r + 2 : r}
                fill={color}
                opacity={dim ? 0.18 : (node.confidence < 0.08 ? 0.35 : 0.82)}
                stroke={isHovered ? "#e8eaed" : "none"}
                strokeWidth="1"
              />
              {/* Label — high-confidence only, full mode */}
              {!compact && node.confidence > 0.55 && !dim && (
                <text
                  x={pos.x + r + 4} y={pos.y + 3}
                  fontSize="7.5"
                  fill="#e8eaed"
                  opacity={isHovered || isConnected ? 0.9 : 0.55}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {node.label.length > 26 ? node.label.slice(0, 26) + "…" : node.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredNode && (() => {
        const pos = positions.get(hoveredNode.id)!;
        const xPct = (pos.x / W) * 100;
        const yPct = (pos.y / H) * 100;
        const score = hoveredNode.score;
        const scoreStr = `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
        const conf = Math.round(hoveredNode.confidence * 100);
        const scoreColor = score > 0.08 ? "#f59e0b" : score < -0.08 ? "#3b82f6" : "#8b99aa";

        return (
          <div style={{
            position: "absolute",
            left:   xPct > 55 ? undefined : `${xPct + 2}%`,
            right:  xPct > 55 ? `${100 - xPct + 2}%` : undefined,
            top:    yPct > 60 ? undefined : `${yPct + 2}%`,
            bottom: yPct > 60 ? `${100 - yPct + 2}%` : undefined,
            background: "#111214",
            border: "1px solid #1e2022",
            padding: "7px 10px",
            fontSize: "11px",
            lineHeight: 1.5,
            maxWidth: "210px",
            pointerEvents: "none",
            zIndex: 20,
            fontFamily: "var(--font)",
          }}>
            <div style={{ fontWeight: 700, color: "#e8eaed", marginBottom: 2, fontSize: "11px" }}>
              {hoveredNode.label}
            </div>
            <div style={{ color: "#8b99aa", fontSize: "10px", marginBottom: 4 }}>
              {hoveredNode.leftPole} ↔ {hoveredNode.rightPole}
            </div>
            <div style={{ fontSize: "10px", color: "#8b99aa" }}>
              <span style={{ color: scoreColor, fontWeight: 700 }}>{scoreStr}</span>
              {" · "}{conf}% conf{" · "}{hoveredNode.evidenceCount} obs
            </div>
          </div>
        );
      })()}
    </div>
  );
}
