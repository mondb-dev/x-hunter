"use client";

import type { Stance } from "@/lib/readStances";

interface StanceBarProps {
  stance: Stance;
  /** Pre-resolved labels of the grounding axes (page maps axis_id → label). */
  groundingLabels?: string[];
}

function truncate(text: string, max = 42): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function strengthWord(position: number): string {
  const m = Math.abs(position || 0);
  if (m > 0.6) return "strongly";
  if (m > 0.35) return "clearly";
  if (m > 0.15) return "cautiously";
  return "tentatively";
}

export default function StanceBar({ stance, groundingLabels = [] }: StanceBarProps) {
  const isTaste = stance.type === "taste";
  const hasSpectrum = !isTaste && Number.isFinite(stance.position as number) && !!stance.pole_a && !!stance.pole_b;
  const position = hasSpectrum ? (stance.position as number) : 0;

  // position [-1,+1] → [0%,100%]; fill from center toward marker (AxisBar convention)
  const pct = ((position + 1) / 2) * 100;
  const fillLeft = position >= 0 ? 50 : pct;
  const fillWidth = Math.abs(pct - 50);
  const fillColor = position > 0 ? "var(--amber)" : position < 0 ? "var(--accent)" : "transparent";
  const posStr = `${position >= 0 ? "+" : ""}${position.toFixed(2)}`;

  const resolved = stance.status !== "open";
  const statusColor =
    stance.was_right === true ? "#57d68d" : stance.was_right === false ? "#e06060" : "var(--muted)";
  const statusText =
    stance.status === "open"
      ? "open"
      : stance.was_right === true
      ? "called it"
      : stance.was_right === false
      ? "was wrong"
      : stance.status;

  return (
    <div className={`axis-bar${resolved ? " axis-inactive" : ""}`}>
      <div className="axis-header">
        <span className="axis-label">
          {stance.event}
          {isTaste && <span style={{ color: "var(--muted)", fontSize: "10px", marginLeft: "0.5rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>taste</span>}
        </span>
        <div className="axis-meta-right">
          {hasSpectrum && <span className={position >= 0 ? "axis-score axis-score-pos" : "axis-score axis-score-neg"}>{posStr}</span>}
          {!isTaste && <span className="axis-confidence">{stance.confidence_pct}% odds</span>}
          <span style={{ color: statusColor, fontSize: "11px" }}>{statusText}</span>
        </div>
      </div>

      {hasSpectrum ? (
        <>
          <div className="axis-poles">
            <span className="pole left">{truncate(stance.pole_a as string)}</span>
            <span className="pole right">{truncate(stance.pole_b as string)}</span>
          </div>
          <div className="axis-track">
            <div className="axis-center-tick" />
            <div className="axis-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%`, background: fillColor }} />
            <div className="axis-marker" style={{ left: `${pct}%` }} />
          </div>
          <div style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "0.35rem" }}>
            I {strengthWord(position)} lean toward “{position >= 0 ? stance.pole_b : stance.pole_a}”
            {stance.rationale ? <> — {stance.rationale}</> : null}
          </div>
        </>
      ) : (
        <div style={{ fontSize: "12px", color: "var(--muted)", marginBottom: "0.35rem" }}>
          {stance.side}
          {stance.rationale ? <> — {stance.rationale}</> : null}
        </div>
      )}

      {resolved && stance.outcome && (
        <div style={{ fontSize: "12px", color: statusColor, marginBottom: "0.35rem" }}>
          resolved{stance.resolved_at ? ` ${stance.resolved_at}` : ""}: {stance.outcome}
        </div>
      )}

      {(groundingLabels.length > 0 || stance.research?.key_finding) && (
        <div className="axis-topics">
          {groundingLabels.map((l) => (
            <span key={l} className="topic-tag">{l}</span>
          ))}
          {stance.research?.key_finding && (
            <span className="topic-tag" title={stance.research.key_finding}>
              researched{stance.research.confidence_pct != null ? ` ${stance.research.confidence_pct}%` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
