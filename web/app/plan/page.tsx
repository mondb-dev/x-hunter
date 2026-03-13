import { readSprintSnapshot, readActivePlan } from "@/lib/readSprints";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Plan — Sebastian D. Hunter",
  description: "Active plan and sprint progress.",
};

function statusIcon(status: string): string {
  if (status === "done" || status === "completed") return "✓";
  if (status === "in_progress" || status === "active") return "▸";
  return "○";
}

function statusClass(status: string): string {
  if (status === "done" || status === "completed") return "plan-done";
  if (status === "in_progress" || status === "active") return "plan-active";
  return "plan-pending";
}

function daysRemaining(target: string | null): string {
  if (!target) return "—";
  const diff = Math.ceil(
    (new Date(target).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return `${diff}d`;
}

export default async function PlanPage() {
  const snapshot = readSprintSnapshot();
  const plan = readActivePlan();

  const hasData = snapshot.plan_status !== "none" && snapshot.plan_title;

  if (!hasData && !plan) {
    return (
      <section>
        <div className="report-header">
          <p className="report-day">Plan</p>
          <h1 className="report-title">No active plan</h1>
        </div>
        <p style={{ color: "var(--muted)" }}>
          Sebastian hasn&apos;t committed to a plan yet. Check back after the next
          ponder cycle.
        </p>
      </section>
    );
  }

  // Use snapshot data if available, else fall back to active_plan.json
  const title = snapshot.plan_title || plan?.title || "Untitled Plan";
  const status = snapshot.plan_status || plan?.status || "unknown";
  const activated = snapshot.activated || plan?.activated_date || "";
  const targetEnd = snapshot.target_end;
  const brief = snapshot.brief || plan?.brief || "";
  const sprints = snapshot.sprints || [];
  const currentWeek = snapshot.current_week;
  const currentGoal = snapshot.current_goal;
  const currentTasks = snapshot.current_tasks || [];
  const accomplishments = snapshot.accomplishments || [];
  const beliefAxes = snapshot.belief_axes?.length
    ? snapshot.belief_axes
    : plan?.belief_axes || [];
  const milestones = plan?.research?.milestones || [];

  const totalTasks = sprints.reduce((s, w) => s + w.tasks_total, 0);
  const doneTasks = sprints.reduce((s, w) => s + w.tasks_done, 0);
  const completedSprints = sprints.filter(
    (s) => s.status === "completed"
  ).length;

  return (
    <section>
      <div className="report-header">
        <p className="report-day">
          Plan · {status === "active" ? "Active" : status}
        </p>
        <h1 className="report-title">{title}</h1>
      </div>

      {/* Stats bar */}
      <div className="about-stats">
        <div className="about-stat">
          <span className="about-stat-val">{daysRemaining(targetEnd)}</span>
          <span className="about-stat-key">remaining</span>
        </div>
        <div className="about-stat">
          <span className="about-stat-val">
            {doneTasks}/{totalTasks}
          </span>
          <span className="about-stat-key">tasks done</span>
        </div>
        <div className="about-stat">
          <span className="about-stat-val">
            {completedSprints}/{sprints.length}
          </span>
          <span className="about-stat-key">sprints done</span>
        </div>
        {currentWeek && (
          <div className="about-stat">
            <span className="about-stat-val">Week {currentWeek}</span>
            <span className="about-stat-key">current</span>
          </div>
        )}
      </div>

      {/* Brief */}
      {brief && (
        <div className="plan-section">
          <h2 className="plan-section-title">Mission</h2>
          <p className="plan-brief">{brief}</p>
        </div>
      )}

      {/* Current sprint */}
      {currentWeek && (
        <div className="plan-section">
          <h2 className="plan-section-title">
            Current Sprint — Week {currentWeek}
          </h2>
          {currentGoal && <p className="plan-sprint-goal">{currentGoal}</p>}

          {currentTasks.length > 0 && (
            <ul className="plan-task-list">
              {currentTasks.map((t) => (
                <li key={t.id} className={`plan-task ${statusClass(t.status)}`}>
                  <span className="plan-task-icon">{statusIcon(t.status)}</span>
                  <span className="plan-task-title">{t.title}</span>
                  <span className="plan-task-type">{t.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Sprint timeline */}
      {sprints.length > 0 && (
        <div className="plan-section">
          <h2 className="plan-section-title">Sprint Timeline</h2>
          <div className="plan-timeline">
            {sprints.map((s) => (
              <div
                key={s.week}
                className={`plan-sprint-card ${statusClass(s.status)} ${
                  s.week === currentWeek ? "plan-sprint-current" : ""
                }`}
              >
                <div className="plan-sprint-header">
                  <span className="plan-sprint-week">
                    {statusIcon(s.status)} Week {s.week}
                  </span>
                  <span className="plan-sprint-progress">
                    {s.tasks_done}/{s.tasks_total}
                  </span>
                </div>
                <p className="plan-sprint-goal">{s.goal}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Milestones from plan research */}
      {milestones.length > 0 && (
        <div className="plan-section">
          <h2 className="plan-section-title">Milestones</h2>
          <div className="plan-milestones">
            {milestones.map((m) => {
              const sprint = sprints.find((s) => s.week === m.week);
              const ms = sprint?.status || "not_started";
              return (
                <div
                  key={m.week}
                  className={`plan-milestone ${statusClass(ms)}`}
                >
                  <span className="plan-milestone-week">
                    {statusIcon(ms)} Week {m.week}
                  </span>
                  <span className="plan-milestone-goal">{m.goal}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent accomplishments */}
      {accomplishments.length > 0 && (
        <div className="plan-section">
          <h2 className="plan-section-title">Recent Accomplishments</h2>
          <ul className="plan-accomplishments">
            {accomplishments.map((a, i) => (
              <li key={i} className="plan-accomplishment">
                <span className="plan-acc-date">{a.date}</span>
                <span className="plan-acc-desc">{a.description}</span>
                {a.impact && (
                  <span className="plan-acc-impact">{a.impact}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Belief axes */}
      {beliefAxes.length > 0 && (
        <div className="plan-section">
          <h2 className="plan-section-title">Connected Belief Axes</h2>
          <div className="plan-axes">
            {beliefAxes.map((axis) => (
              <span key={axis} className="plan-axis-tag">
                {axis}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Snapshot timestamp */}
      {snapshot.snapshot_at && (
        <p className="plan-snapshot-time">
          Last updated:{" "}
          {new Date(snapshot.snapshot_at).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      )}
    </section>
  );
}
