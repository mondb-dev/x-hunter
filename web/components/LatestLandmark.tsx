import { getLatestLandmark } from "@/lib/readLandmarks";

export default function LatestLandmark() {
  try {
    const lm = getLatestLandmark();

    if (!lm) {
      return (
        <div className="latest-landmark-wrap">
          <div className="latest-landmark-label">latest landmark</div>
          <div className="latest-landmark-empty">No landmark events detected yet.</div>
        </div>
      );
    }

    const dateObj = new Date(lm.dateStr || lm.date);
    const dateStr = !isNaN(dateObj.getTime())
      ? dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : lm.date;

    // Shorten axis IDs to readable labels
    const axisLabels = lm.axesImpacted
      .map((id) => id.replace(/^axis_/, "").replace(/_v\d+$/, "").replace(/_/g, " "))
      .slice(0, 3);

    return (
      <div className="latest-landmark-wrap">
        <div className="latest-landmark-label">
          latest landmark
          <span className="latest-landmark-signals">
            {lm.signalCount}/{lm.signalGate} signals · {lm.postCount} posts
          </span>
        </div>
        <div className="latest-landmark-card">
          <p className="latest-landmark-headline">{lm.headline}</p>
          {lm.lead && <p className="latest-landmark-lead">{lm.lead}</p>}
          <div className="latest-landmark-footer">
            <span className="latest-landmark-time">{dateStr}</span>
            <div className="latest-landmark-meta">
              {axisLabels.length > 0 && (
                <span className="latest-landmark-axes">
                  axes: {axisLabels.join(" · ")}
                </span>
              )}
              {lm.topKeywords.length > 0 && (
                <span className="latest-landmark-keywords">
                  {lm.topKeywords.slice(0, 5).join(", ")}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  } catch (err) {
    console.error("[LatestLandmark] render failed:", err);
    return null;
  }
}
