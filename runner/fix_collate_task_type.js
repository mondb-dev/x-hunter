#!/usr/bin/env node
// One-off: fix task_type for "Collate All Feedback and Learnings" from "research" → "reflect"
'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../state/sprints.db');
const db = new Database(dbPath);

const rows = db.prepare("SELECT id, title, task_type FROM tasks WHERE title LIKE '%Collate%'").all();
console.log('Found tasks:', rows);

if (rows.length === 0) {
  console.log('No matching task found — nothing to do.');
  process.exit(0);
}

for (const row of rows) {
  if (row.task_type === 'research') {
    db.prepare("UPDATE tasks SET task_type = 'reflect' WHERE id = ?").run(row.id);
    console.log(`Updated task ${row.id} "${row.title}": research → reflect`);
  } else {
    console.log(`Task ${row.id} "${row.title}" already has type "${row.task_type}" — no change.`);
  }
}

db.close();
console.log('Done.');
