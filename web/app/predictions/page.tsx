import { notFound } from "next/navigation";
import { readPredictions } from "../../lib/readPredictions";
import type { ResolutionStatus, Prediction } from "../../lib/readPredictions";



const STATUS_LABEL: Record<ResolutionStatus, string> = {
  pending: "Pending",
  correct: "Correct",
  wrong: "Wrong",
  partial: "Partial",
  expired: "Expired",
};

const STATUS_COLOR: Record<ResolutionStatus, string> = {
  pending: "#8b99aa",
  correct: "#22c55e",
  wrong: "#ef4444",
  partial: "#f59e0b",
  expired: "#6b7280",
};

function StatusBadge({ status }: { status: ResolutionStatus }) {
  const color = STATUS_COLOR[status] ?? "#8b99aa";
  return (
    <span
      style={{
        fontSize: "10px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color,
        border: `1px solid ${color}`,
        borderRadius: "3px",
        padding: "2px 6px",
        flexShrink: 0,
      }}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function ConfidenceBar({ pct }: { pct: number }) {
  const color = pct >= 70 ? "#3b82f6" : pct >= 50 ? "#f59e0b" : "#6b7280";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <div
        style={{
          flex: 1,
          height: "4px",
          background: "rgba(255,255,255,0.08)",
          borderRadius: "2px",
          overflow: "hidden",
          maxWidth: "80px",
        }}
      >
        <div
          style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: "2px" }}
        />
      </div>
      <span style={{ fontSize: "12px", color, fontWeight: 600, minWidth: "32px" }}>{pct}%</span>
    </div>
  );
}

function PredictionCard({ p }: { p: Prediction }) {
  const status = p.resolution_status ?? "pending";
  const date = new Date(p.ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const deadline = p.deadline_at
    ? new Date(p.deadline_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "6px",
        padding: "1.1rem 1.25rem",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.75rem",
          marginBottom: "0.6rem",
          flexWrap: "wrap",
        }}
      >
        <StatusBadge status={status} />
        <span style={{ fontSize: "11px", color: "var(--muted)", marginLeft: "auto" }}>{date}</span>
      </div>

      {/* Prediction text */}
      {p.tweet_url ? (
        <a
          href={p.tweet_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "block",
            fontSize: "14px",
            lineHeight: 1.6,
            color: "var(--text)",
            marginBottom: "0.75rem",
            textDecoration: "none",
          }}
        >
          {p.prediction}
        </a>
      ) : (
        <p
          style={{
            fontSize: "14px",
            lineHeight: 1.6,
            color: "var(--text)",
            margin: "0 0 0.75rem",
          }}
        >
          {p.prediction}
        </p>
      )}

      {/* Meta row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        {p.confidence_pct != null && <ConfidenceBar pct={p.confidence_pct} />}
        {deadline && status === "pending" && (
          <span style={{ fontSize: "11px", color: "var(--muted)" }}>
            Resolves by {deadline}
          </span>
        )}
        {p.top_axes && p.top_axes.length > 0 && (
          <span
            style={{ fontSize: "11px", color: "var(--muted)", flex: 1, textAlign: "right" }}
          >
            {p.top_axes[0]}
            {p.top_axes.length > 1 ? ` +${p.top_axes.length - 1}` : ""}
          </span>
        )}
      </div>

      {/* Resolution note */}
      {p.resolution_note && (
        <div
          style={{
            marginTop: "0.7rem",
            paddingTop: "0.7rem",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            fontSize: "13px",
            color: "var(--muted)",
            fontStyle: "italic",
          }}
        >
          {p.resolution_note}
        </div>
      )}
    </div>
  );
}

export default async function PredictionsPage() {
  const data = await readPredictions();
  if (!data) return notFound();

  const { stats, predictions } = data;
  const resolved = stats.correct + stats.wrong + stats.partial;

  return (
    <div className="verify-page">
      <header className="verify-header">
        <span className="verify-eyebrow">Predictions</span>
        <h1 className="verify-title">Track Record</h1>
        <p className="verify-description">
          Sebastian&apos;s public predictions — generated from observed belief drift,
          scored with explicit confidence, and resolved against real outcomes.
          {data.generated_at && (
            <>
              {" "}Updated{" "}
              {new Date(data.generated_at).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "UTC",
                timeZoneName: "short",
              })}
              .
            </>
          )}
        </p>
      </header>

      {/* Scoreboard stats */}
      <div className="verify-stats" style={{ marginBottom: "2rem" }}>
        <div className="verify-stat">
          <div className="verify-stat-value">{stats.total}</div>
          <div className="verify-stat-label">Total</div>
        </div>
        <div className="verify-stat">
          <div className="verify-stat-value" style={{ color: "#22c55e" }}>{stats.correct}</div>
          <div className="verify-stat-label">Correct</div>
        </div>
        <div className="verify-stat">
          <div className="verify-stat-value" style={{ color: "#ef4444" }}>{stats.wrong}</div>
          <div className="verify-stat-label">Wrong</div>
        </div>
        <div className="verify-stat">
          <div className="verify-stat-value" style={{ color: "#f59e0b" }}>{stats.partial}</div>
          <div className="verify-stat-label">Partial</div>
        </div>
        <div className="verify-stat">
          <div className="verify-stat-value">
            {stats.accuracy != null ? `${stats.accuracy}%` : "—"}
          </div>
          <div className="verify-stat-label">Accuracy{resolved > 0 ? ` (${resolved} resolved)` : ""}</div>
        </div>
        <div className="verify-stat">
          <div className="verify-stat-value" style={{ color: "var(--muted)" }}>{stats.pending}</div>
          <div className="verify-stat-label">Pending</div>
        </div>
      </div>

      {/* Prediction list */}
      {predictions.length === 0 ? (
        <p className="verify-empty">No predictions yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {predictions.map((p, i) => (
            <PredictionCard key={p.id ?? i} p={p} />
          ))}
        </div>
      )}

      <div className="verify-methodology" style={{ marginTop: "3rem" }}>
        <h3>Methodology</h3>
        <p>
          Predictions are generated when three or more belief axes show measurable discourse
          drift within 48 hours. Each prediction includes a confidence estimate from the model,
          a 30-day resolution window, and is assessed against ontology evidence gathered after
          the prediction was made. Verdicts: <strong>Correct</strong> (core claim happened),{" "}
          <strong>Wrong</strong> (clearly falsified), <strong>Partial</strong> (partly true),{" "}
          <strong>Expired</strong> (deadline passed without resolution).
        </p>
      </div>
    </div>
  );
}
