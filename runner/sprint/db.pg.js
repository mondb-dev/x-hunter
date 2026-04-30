/**
 * runner/sprint/db.pg.js — Postgres version of sprint planning DB
 *
 * Async replacement for db.js (better-sqlite3).
 * Same exported function names, all return Promises.
 */

'use strict';

const { query, transaction } = require('../lib/pg');

// ── Plan helpers ────────────────────────────────────────────────────────────

async function getActivePlan() {
  const { rows } = await query("SELECT * FROM plans WHERE status = 'active' LIMIT 1");
  return rows[0] || null;
}

async function upsertPlan({ plan_id, title, compulsion, brief, success_30d, belief_axes, activated_date }) {
  const target_end_date = addDays(activated_date, 30);
  const { rows: existing } = await query('SELECT id FROM plans WHERE plan_id = $1', [plan_id]);

  if (existing.length > 0) {
    await query(`
      UPDATE plans SET title = $1, compulsion = $2, brief = $3, success_30d = $4,
        belief_axes = $5, activated_date = $6, target_end_date = $7, status = 'active'
      WHERE plan_id = $8
    `, [title, compulsion, brief, success_30d, JSON.stringify(belief_axes), activated_date, target_end_date, plan_id]);
  } else {
    await query(`
      INSERT INTO plans (plan_id, title, compulsion, brief, success_30d, belief_axes, activated_date, target_end_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [plan_id, title, compulsion, brief, success_30d, JSON.stringify(belief_axes), activated_date, target_end_date]);
  }

  const { rows } = await query('SELECT * FROM plans WHERE plan_id = $1', [plan_id]);
  return rows[0];
}

async function completePlan(plan_id, date) {
  await query("UPDATE plans SET status = 'completed', completed_date = $1 WHERE plan_id = $2", [date, plan_id]);
}

// ── Sprint helpers ──────────────────────────────────────────────────────────

async function getSprints(plan_id) {
  const { rows } = await query('SELECT * FROM sprints WHERE plan_id = $1 ORDER BY week', [plan_id]);
  return rows;
}

async function getCurrentSprint(plan_id) {
  const { rows } = await query(
    "SELECT * FROM sprints WHERE plan_id = $1 AND status = 'active' ORDER BY week LIMIT 1",
    [plan_id]
  );
  return rows[0] || null;
}

async function upsertSprint({ plan_id, week, goal, start_date, end_date }) {
  const { rows: existing } = await query(
    'SELECT id FROM sprints WHERE plan_id = $1 AND week = $2', [plan_id, week]
  );

  if (existing.length > 0) {
    await query('UPDATE sprints SET goal = $1, start_date = $2, end_date = $3 WHERE id = $4',
      [goal, start_date || null, end_date || null, existing[0].id]);
    return existing[0].id;
  }

  const { rows } = await query(
    'INSERT INTO sprints (plan_id, week, goal, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [plan_id, week, goal, start_date || null, end_date || null]
  );
  return rows[0].id;
}

async function activateSprint(sprint_id, start_date) {
  await query("UPDATE sprints SET status = 'active', start_date = $1 WHERE id = $2", [start_date, sprint_id]);
}

async function completeSprint(sprint_id, retro) {
  await query("UPDATE sprints SET status = 'completed', retro = $1 WHERE id = $2", [retro || null, sprint_id]);
}

// ── Task helpers ────────────────────────────────────────────────────────────

async function getTasks(sprint_id) {
  const { rows } = await query('SELECT * FROM tasks WHERE sprint_id = $1 ORDER BY priority, id', [sprint_id]);
  return rows;
}

async function getTasksByStatus(sprint_id, status) {
  const { rows } = await query(
    'SELECT * FROM tasks WHERE sprint_id = $1 AND status = $2 ORDER BY priority, id',
    [sprint_id, status]
  );
  return rows;
}

async function addTask({ sprint_id, title, description, task_type, priority, estimated_hours }) {
  const { rows } = await query(`
    INSERT INTO tasks (sprint_id, title, description, task_type, priority, estimated_hours)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
  `, [sprint_id, title, description || null, task_type || 'action', priority || 2, estimated_hours || null]);
  return rows[0].id;
}

async function updateTaskStatus(task_id, status, output_ref) {
  const completed_date = status === 'done' ? new Date().toISOString().slice(0, 10) : null;
  await query(`
    UPDATE tasks SET status = $1, output_ref = COALESCE($2, output_ref),
      completed_date = COALESCE($3, completed_date) WHERE id = $4
  `, [status, output_ref || null, completed_date, task_id]);
}

// Strings the LLM sometimes emits in place of an actual artifact path.
// Normalize all of these to SQL NULL so output_ref is either a real path or empty.
const ARTIFACT_PLACEHOLDERS = new Set(["", "(none)", "none", "n/a", "na", "null", "tbd", "todo"]);
function normalizeArtifact(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (ARTIFACT_PLACEHOLDERS.has(s.toLowerCase())) return null;
  return s;
}

async function bulkInsertTasks(sprint_id, tasks) {
  await transaction(async (client) => {
    for (const t of tasks) {
      await client.query(`
        INSERT INTO tasks (sprint_id, title, description, task_type, priority, estimated_hours, output_ref)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        sprint_id,
        t.title,
        t.description || null,
        t.task_type || 'action',
        t.priority || 2,
        t.estimated_hours || null,
        normalizeArtifact(t.artifact || t.output_ref),
      ]);
    }
  });
}

async function rolloverTasks(fromSprintId, toSprintId) {
  const { rows: incomplete } = await query(
    "SELECT * FROM tasks WHERE sprint_id = $1 AND status != 'done'", [fromSprintId]
  );
  if (incomplete.length === 0) return 0;

  await transaction(async (client) => {
    for (const t of incomplete) {
      await client.query(`
        INSERT INTO tasks (sprint_id, title, description, task_type, priority, estimated_hours, output_ref)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        toSprintId,
        `[carried] ${t.title}`,
        t.description || null,
        t.task_type,
        Math.max(1, (t.priority || 2) - 1),
        t.estimated_hours || null,
        normalizeArtifact(t.output_ref),
      ]);
    }
  });
  return incomplete.length;
}

// ── Accomplishment helpers ──────────────────────────────────────────────────

async function addAccomplishment({ plan_id, task_id, date, description, evidence, impact }) {
  await query(`
    INSERT INTO accomplishments (plan_id, task_id, date, description, evidence, impact)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [plan_id, task_id || null, date, description, evidence || null, impact || null]);
}

async function getAccomplishments(plan_id, since_date) {
  if (since_date) {
    const { rows } = await query(
      'SELECT * FROM accomplishments WHERE plan_id = $1 AND date >= $2 ORDER BY date DESC',
      [plan_id, since_date]
    );
    return rows;
  }
  const { rows } = await query(
    'SELECT * FROM accomplishments WHERE plan_id = $1 ORDER BY date DESC', [plan_id]
  );
  return rows;
}

// ── Daily log helpers ───────────────────────────────────────────────────────

async function upsertDailyLog({ plan_id, date, focus, active_tasks, blockers, notes }) {
  await query(`
    INSERT INTO daily_logs (plan_id, date, focus, active_tasks, blockers, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT(plan_id, date) DO UPDATE SET
      focus = EXCLUDED.focus, active_tasks = EXCLUDED.active_tasks,
      blockers = EXCLUDED.blockers, notes = EXCLUDED.notes
  `, [plan_id, date, focus || null, active_tasks || null, blockers || null, notes || null]);
}

async function getDailyLog(plan_id, date) {
  const { rows } = await query(
    'SELECT * FROM daily_logs WHERE plan_id = $1 AND date = $2', [plan_id, date]
  );
  return rows[0] || null;
}

async function getRecentDailyLogs(plan_id, limit) {
  const { rows } = await query(
    'SELECT * FROM daily_logs WHERE plan_id = $1 ORDER BY date DESC LIMIT $2',
    [plan_id, limit || 7]
  );
  return rows;
}

// ── Summary / context helpers ───────────────────────────────────────────────

async function getSprintSummary(plan_id) {
  const { rows: planRows } = await query('SELECT * FROM plans WHERE plan_id = $1', [plan_id]);
  const plan = planRows[0];
  if (!plan) return null;

  const sprints = await getSprints(plan_id);
  const current = await getCurrentSprint(plan_id);

  const sprintSummaries = [];
  for (const s of sprints) {
    const tasks = await getTasks(s.id);
    const done = tasks.filter(t => t.status === 'done').length;
    sprintSummaries.push({
      week: s.week, goal: s.goal, status: s.status,
      tasks_total: tasks.length, tasks_done: done,
    });
  }

  const result = {
    plan_title: plan.title,
    plan_status: plan.status,
    activated: plan.activated_date,
    target_end: plan.target_end_date,
    total_sprints: sprints.length,
    current_week: current ? current.week : null,
    current_goal: current ? current.goal : null,
    sprints: sprintSummaries,
  };

  if (current) {
    const tasks = await getTasks(current.id);
    result.current_tasks = tasks.map(t => ({
      id: t.id, title: t.title, status: t.status, type: t.task_type,
    }));
  }

  return result;
}

async function buildPromptContext(plan_id) {
  const summary = await getSprintSummary(plan_id);
  if (!summary) return '(no active sprint)';

  const lines = [];
  lines.push(`PLAN: ${summary.plan_title} (${summary.plan_status})`);
  lines.push(`Timeline: ${summary.activated} → ${summary.target_end}`);

  if (summary.current_week) {
    lines.push(`Current: Week ${summary.current_week} — ${summary.current_goal}`);
    if (summary.current_tasks?.length) {
      lines.push('Tasks:');
      for (const t of summary.current_tasks) {
        const icon = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '▸' : '○';
        lines.push(`  ${icon} [${t.type}] ${t.title}`);
      }
    }
  }

  for (const s of summary.sprints) {
    if (s.week === summary.current_week) continue;
    const icon = s.status === 'completed' ? '✓' : s.status === 'active' ? '▸' : '○';
    lines.push(`${icon} Week ${s.week}: ${s.goal} (${s.tasks_done}/${s.tasks_total} done)`);
  }

  return lines.join('\n');
}

// ── Utility ─────────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function close() {
  await require('../lib/pg').close();
}

module.exports = {
  // Plan
  getActivePlan, upsertPlan, completePlan,
  // Sprint
  getSprints, getCurrentSprint, upsertSprint, activateSprint, completeSprint,
  // Task
  getTasks, getTasksByStatus, addTask, updateTaskStatus, bulkInsertTasks, rolloverTasks,
  // Accomplishment
  addAccomplishment, getAccomplishments,
  // Daily log
  upsertDailyLog, getDailyLog, getRecentDailyLogs,
  // Summary
  getSprintSummary, buildPromptContext,
  // Util
  addDays, close,
};
