'use strict';

// orchestrator.js — Node orchestrator stub (Phase 0)
//
// This file is invoked by run.sh when ORCHESTRATOR=node.
// Currently a stub — exits cleanly. Will be implemented in Phase 5.
//
// run.sh uses `exec` to replace itself with this process, so:
//   - Bash traps (lock cleanup, scraper/stream stop) are LOST after exec.
//   - This file MUST handle its own signal cleanup once implemented.
//   - See docs/ORCHESTRATOR_MIGRATION.md "A/B Switch Mechanism" for details.

const path = require('path');
const fs = require('fs');
const config = require('./lib/config');

// ── Signal handlers (critical — bash traps don't survive exec) ──────────────
function cleanup() {
  try { fs.rmSync(config.LOCKDIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(config.PIDFILE, { force: true }); } catch {}
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  const { execSync } = require('child_process');
  try { execSync(`bash "${config.SCRAPER_DIR}/stop.sh"`, { stdio: 'ignore' }); } catch {}
  try { execSync(`bash "${config.STREAM_DIR}/stop.sh"`, { stdio: 'ignore' }); } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => process.emit('SIGINT'));

// ── Stub ────────────────────────────────────────────────────────────────────
console.log('[orchestrator] Node orchestrator not yet implemented (Phase 0 stub)');
console.log('[orchestrator] Set ORCHESTRATOR=bash to use the bash runner');
console.log('[orchestrator] Exiting cleanly.');
process.exit(0);
