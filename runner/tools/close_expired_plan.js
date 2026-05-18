#!/usr/bin/env node
/**
 * runner/tools/close_expired_plan.js — one-shot: close a stuck active plan
 *
 * Marks active_plan.json as expired, closes all open sprints in the DB,
 * and clears sprint_context.txt so the next cycle starts clean.
 *
 * Run on the VM:
 *   node runner/tools/close_expired_plan.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT  = path.resolve(__dirname, '../..');
const STATE = path.join(ROOT, 'state');

const ACTIVE_PLAN_PATH    = path.join(STATE, 'active_plan.json');
const SPRINT_CONTEXT_PATH = path.join(STATE, 'sprint_context.txt');

function today() { return new Date().toISOString().slice(0, 10); }

async function main() {
  // 1. Read and close active_plan.json
  const raw = fs.existsSync(ACTIVE_PLAN_PATH) ? fs.readFileSync(ACTIVE_PLAN_PATH, 'utf-8') : null;
  if (!raw) { console.log('[close_expired_plan] no active_plan.json found — nothing to do'); return; }

  const plan = JSON.parse(raw);
  if (plan.status !== 'active') {
    console.log(`[close_expired_plan] plan status is already "${plan.status}" — nothing to do`);
    return;
  }

  const planId = plan.id || `plan_${plan.activated_date}`;
  const activated = plan.activated_date || '?';
  const daysSince = activated !== '?' ? Math.round((Date.now() - new Date(activated)) / 86_400_000) : '?';
  console.log(`[close_expired_plan] closing plan "${plan.title}" (${planId}, active ${daysSince}d)`);

  fs.writeFileSync(ACTIVE_PLAN_PATH, JSON.stringify({ ...plan, status: 'expired', expired_date: today() }, null, 2));
  console.log('[close_expired_plan] active_plan.json → expired');

  // 2. Close plan in sprints.db
  const { loadSprintDb } = require('../lib/db_backend');
  const sprintDb = loadSprintDb();
  try {
    await sprintDb.completePlan(planId, today());
    console.log(`[close_expired_plan] sprints.db plan ${planId} → completed`);
  } catch (err) {
    console.warn(`[close_expired_plan] sprintDb.completePlan warning: ${err.message}`);
  }
  await sprintDb.close();

  // 3. Clear sprint context
  fs.writeFileSync(SPRINT_CONTEXT_PATH, '(no active plan)');
  console.log('[close_expired_plan] sprint_context.txt cleared');

  console.log('[close_expired_plan] done — ponder will fire on next eligible cycle');
}

main().catch(err => { console.error('[close_expired_plan] error:', err.message); process.exit(1); });
