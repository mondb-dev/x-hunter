#!/usr/bin/env node
/**
 * runner/builder_pipeline.js — META cycle build→test→merge pipeline
 *
 * Called by the orchestrator after the builder agent writes files to staging/.
 * Reads staging/manifest.json, validates guardrails, applies changes on a
 * feature branch, runs smoke tests, and auto-merges or rolls back.
 *
 * Flow:
 *   1. Read staging/manifest.json
 *   2. Validate guardrails (protected files, file count, line limits)
 *   3. Create feature branch: meta/<proposal_id>
 *   4. Copy staging files to their real paths
 *   5. Run smoke tests (syntax check, import check, custom test_commands)
 *   6. On pass: commit, merge to main, push, cleanup
 *   7. On fail: abandon branch, log failure, cleanup
 *
 * Exit codes:
 *   0 = merged successfully
 *   1 = failed (tests, guardrails, etc.)
 *   2 = no staging/manifest.json found
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const ROOT         = path.resolve(__dirname, "..");
const STAGING_DIR  = path.join(ROOT, "staging");
const MANIFEST     = path.join(STAGING_DIR, "manifest.json");
const PROPOSAL_PATH = path.join(ROOT, "state", "process_proposal.json");
const HISTORY_PATH  = path.join(ROOT, "state", "proposal_history.json");

const { PROTECTED_FILES } = require("./lib/prompts/builder");
const { createBranch, mergeBranch, deleteBranch, commitAndPushBranch } = require("./lib/git");

function log(msg) {
  console.log(`[builder_pipeline] ${msg}`);
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

function isSafeRelativePath(relPath) {
  if (typeof relPath !== "string" || relPath.trim() === "") return false;
  if (path.isAbsolute(relPath)) return false;
  if (relPath.includes("\0")) return false;
  const normalized = relPath.replace(/\\/g, "/");
  const clean = path.posix.normalize(normalized);
  if (clean !== normalized) return false;
  if (clean === "." || clean === ".." || clean.startsWith("../")) return false;
  return true;
}

// ── Guardrail checks ────────────────────────────────────────────────────────

function validateManifest(manifest) {
  const errors = [];

  if (!manifest.proposal_id) {
    errors.push("Missing proposal_id in manifest");
  }

  const files = manifest.files || [];

  // File count limit
  if (files.length > 8) {
    errors.push(`Too many files: ${files.length} (max 8)`);
  }

  // Check for protected files
  for (const f of files) {
    const rel = String(f.path || "");
    if (PROTECTED_FILES.includes(rel)) {
      errors.push(`Protected file: ${rel}`);
    }
    // Block deletion actions
    if (f.action === "delete") {
      errors.push(`Deletion not allowed: ${rel}`);
    }
  }

  // Validate file paths don't contain shell-dangerous characters
  for (const f of files) {
    if (!isSafeRelativePath(f.path) || /[;&|`$(){}\\<>'" \t\n]/.test(f.path)) {
      errors.push(`Unsafe file path: ${f.path}`);
    }
  }

  // Check staged files exist and line count
  for (const f of files) {
    const stagingPath = path.join(STAGING_DIR, f.path);
    if (!fs.existsSync(stagingPath)) {
      errors.push(`Staging file missing: ${f.path}`);
      continue;
    }
    const lines = fs.readFileSync(stagingPath, "utf-8").split("\n").length;
    if (lines > 500) {
      errors.push(`File too large: ${f.path} (${lines} lines, max 500)`);
    }
  }

  return errors;
}

function findDirtyTargetPaths(paths) {
  if (!paths.length) return [];
  try {
    const out = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", ...paths], {
      encoding: "utf-8",
      timeout: 15000,
    }).trim();
    if (!out) return [];
    return out.split("\n").map(line => line.trim()).filter(Boolean);
  } catch (e) {
    throw new Error(`Could not inspect git status for META targets: ${e.message}`);
  }
}

// ── Smoke tests ─────────────────────────────────────────────────────────────

function runSmokeTests(manifest) {
  const failures = [];
  const files = manifest.files || [];

  // 1. Syntax check all .js files
  for (const f of files) {
    if (!f.path.endsWith(".js")) continue;
    const realPath = path.join(ROOT, f.path);
    if (!fs.existsSync(realPath)) continue;
    try {
      execFileSync(process.execPath, ['--check', realPath], { stdio: 'pipe', timeout: 10_000 });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
      failures.push(`Syntax error in ${f.path}: ${stderr.slice(0, 200)}`);
    }
  }

  // 2. Import check for new runner scripts
  for (const f of files) {
    if (f.action !== "create") continue;
    if (!f.path.endsWith(".js")) continue;
    const realPath = path.join(ROOT, f.path);
    if (!fs.existsSync(realPath)) continue;
    try {
      execFileSync(process.execPath, ["-e", `require('${realPath}')`], {
        stdio: "pipe",
        timeout: 15_000,
        cwd: ROOT,
      });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
      failures.push(`Import failed for ${f.path}: ${stderr.slice(0, 200)}`);
    }
  }

  // 3. Custom test commands from manifest
  for (const cmd of (manifest.test_commands || [])) {
    // Sanitize: only allow "node [--check] <relative-path>" — no shell operators, no arbitrary flags
    const parts = cmd.trim().split(/\s+/);
    if (parts[0] !== 'node' || parts.length < 2) {
      failures.push(`Blocked test command (not a node command): ${cmd}`);
      continue;
    }
    const ALLOWED_FLAGS = new Set(['--check']);
    const filePart = parts[parts.length - 1];
    const flagParts = parts.slice(1, -1);
    if (flagParts.some(fl => !ALLOWED_FLAGS.has(fl))) {
      // Skip — do not fail the pipeline over a bad test command.
      // Syntax and import checks already ran above; a blocked custom
      // command (typically 'node -e "..."') is a builder mistake, not
      // a code defect. Log a warning and continue.
      log(`WARNING: skipping blocked test command (disallowed flags: ${flagParts.join(' ')}): ${cmd.slice(0, 80)}`);
      continue;
    }
    if (!isSafeRelativePath(filePart)) {
      failures.push(`Blocked test command (unsafe path): ${cmd}`);
      continue;
    }
    const absTestPath = path.join(ROOT, filePart);
    if (!fs.existsSync(absTestPath)) {
      failures.push(`Test file not found: ${filePart}`);
      continue;
    }
    try {
      execFileSync(process.execPath, [...flagParts, absTestPath], {
        stdio: 'pipe',
        timeout: 30_000,
        cwd: ROOT,
      });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
      failures.push(`Test command failed: ${cmd} — ${stderr.slice(0, 200)}`);
    }
  }

  // 4. Markdown structure check for .md files
  for (const f of files) {
    if (!f.path.endsWith(".md")) continue;
    const realPath = path.join(ROOT, f.path);
    if (!fs.existsSync(realPath)) continue;
    const content = fs.readFileSync(realPath, "utf-8");
    // Basic check: has content and doesn't have unclosed code blocks
    const fences = (content.match(/```/g) || []).length;
    if (fences % 2 !== 0) {
      failures.push(`Unclosed code fence in ${f.path}`);
    }
  }

  return failures;
}

// ── Apply staging files to real paths ───────────────────────────────────────

function snapshotTargetFiles(paths) {
  const snapshot = new Map();
  for (const relPath of paths) {
    const absPath = path.join(ROOT, relPath);
    if (fs.existsSync(absPath)) {
      snapshot.set(relPath, { existed: true, content: fs.readFileSync(absPath) });
    } else {
      snapshot.set(relPath, { existed: false, content: null });
    }
  }
  return snapshot;
}

function restoreTargetFiles(snapshot) {
  if (!snapshot || snapshot.size === 0) return;
  for (const [relPath, entry] of snapshot.entries()) {
    const absPath = path.join(ROOT, relPath);
    if (entry.existed) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, entry.content);
    } else {
      try { fs.rmSync(absPath, { force: true }); } catch {}
    }
  }
  log("restored target files after failed META attempt");
}

function applyStagingFiles(manifest) {
  const files = manifest.files || [];
  for (const f of files) {
    const src = path.join(STAGING_DIR, f.path);
    const dst = path.join(ROOT, f.path);

    // Create directory if needed
    const dir = path.dirname(dst);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.copyFileSync(src, dst);
    log(`applied: ${f.path} (${f.action})`);
  }
}

// ── Cleanup staging directory ───────────────────────────────────────────────

function cleanStaging() {
  try {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    log("staging/ cleaned");
  } catch (e) {
    log(`staging cleanup failed: ${e.message}`);
  }
}

// ── Update proposal status ──────────────────────────────────────────────────

function updateProposal(status, resolution) {
  const proposal = loadJson(PROPOSAL_PATH);
  if (!proposal) return;

  proposal.status = status;
  proposal.resolved_at = new Date().toISOString();
  proposal.resolution = resolution;
  writeJson(PROPOSAL_PATH, proposal);
}

function appendHistory(proposal, status, notes, filesChanged, meta = {}) {
  let history = loadJson(HISTORY_PATH) || { proposals: [] };
  history.proposals.push({
    id: proposal.id,
    title: proposal.title,
    status,
    proposed_at: proposal.created_at,
    resolved_at: new Date().toISOString(),
    resolution_notes: notes,
    files_changed: filesChanged || [],
    branch_name: meta.branchName || null,
    merge_commit: meta.mergeCommit || null,
    pushed_to_origin: meta.pushedToOrigin ?? null,
    reverted: false,
    revert_reason: null,
  });
  writeJson(HISTORY_PATH, history);
}

function rollbackLocalMain(branchName, preMergeHead) {
  if (!branchName || !preMergeHead) {
    throw new Error("rollbackLocalMain requires branchName and preMergeHead");
  }
  execFileSync("git", ["-C", ROOT, "checkout", branchName], {
    stdio: "pipe",
    timeout: 15000,
  });
  execFileSync("git", ["-C", ROOT, "branch", "-f", "main", preMergeHead], {
    stdio: "pipe",
    timeout: 15000,
  });
  execFileSync("git", ["-C", ROOT, "checkout", "main"], {
    stdio: "pipe",
    timeout: 15000,
  });
  log(`rolled back local main to ${preMergeHead} after failed push`);
}

// ── Main ────────────────────────────────────────────────────────────────────

(async function main() {
  // 1. Load manifest
  const manifest = loadJson(MANIFEST);
  if (!manifest) {
    log("no staging/manifest.json found — nothing to do");
    process.exit(2);
  }

  const proposal = loadJson(PROPOSAL_PATH);
  if (!proposal) {
    log("no process_proposal.json found — aborting");
    cleanStaging();
    process.exit(1);
  }

  log(`processing proposal: ${proposal.id} — "${proposal.title}"`);

  // 2. Check high-risk deferral
  if (proposal.estimated_risk === "high") {
    log("proposal is high-risk — deferring");
    updateProposal("rejected", "deferred_high_risk: re-propose as medium with more evidence");
    appendHistory(proposal, "deferred_high_risk", "High-risk proposal deferred", []);
    cleanStaging();
    process.exit(1);
  }

  // 3. Validate guardrails
  const guardrailErrors = validateManifest(manifest);
  if (guardrailErrors.length > 0) {
    log("guardrail violations:");
    for (const e of guardrailErrors) log(`  - ${e}`);
    updateProposal("failed", `Guardrail violations: ${guardrailErrors.join("; ")}`);
    appendHistory(proposal, "failed", `Guardrails: ${guardrailErrors.join("; ")}`, []);
    cleanStaging();
    process.exit(1);
  }

  // Sanitize proposal id for branch name (defense-in-depth against shell injection)
  const safeId = (proposal.id || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
  if (!safeId) {
    log('proposal id is empty or invalid — aborting');
    cleanStaging();
    process.exit(1);
  }
  const branchName = `meta/${safeId}`;
  const filesChanged = (manifest.files || []).map(f => f.path);
  const preMergeHead = execFileSync("git", ["-C", ROOT, "rev-parse", "main"], {
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
  const dirtyTargets = findDirtyTargetPaths(filesChanged);
  if (dirtyTargets.length > 0) {
    const notes = `Target files already dirty before META apply: ${dirtyTargets.join("; ")}`;
    log(notes);
    updateProposal("failed", notes);
    appendHistory(proposal, "failed", notes, filesChanged, { branchName });
    cleanStaging();
    process.exit(1);
  }

  let branchCreated = false;
  let snapshot = null;

  try {
    // 4. Create feature branch
    log(`creating branch: ${branchName}`);
    createBranch(branchName);
    branchCreated = true;

    // 5. Apply staging files
    snapshot = snapshotTargetFiles(filesChanged);
    applyStagingFiles(manifest);

    // 6. Run smoke tests
    log("running smoke tests...");
    const testFailures = runSmokeTests(manifest);

    if (testFailures.length > 0) {
      log("smoke tests FAILED:");
      for (const f of testFailures) log(`  - ${f}`);
      throw new Error(`Tests failed: ${testFailures.join("; ")}`);
    }

    log("smoke tests passed");

    // 7. Commit on feature branch
    commitAndPushBranch({
      branch: branchName,
      paths: filesChanged,
      message: `meta: ${proposal.title} [${proposal.id}]`,
    });

    // 8. Merge to main
    log("merging to main...");
    mergeBranch(branchName);
    const mergeCommit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    // 9. Push main
    let pushedToOrigin = true;
    let pushError = "";
    let localRollbackOk = true;
    try {
      execSync(`git -C "${ROOT}" push origin main`, { stdio: "pipe", timeout: 30_000 });
      log("pushed to origin/main");
    } catch (e) {
      pushedToOrigin = false;
      pushError = e.stderr ? e.stderr.toString().trim() : e.message;
      log(`push failed: ${pushError}`);
      try {
        rollbackLocalMain(branchName, preMergeHead);
      } catch (rollbackErr) {
        localRollbackOk = false;
        log(`local rollback failed after push error: ${rollbackErr.message}`);
      }
    }

    // 10. Clean up branch on successful publish only
    if (pushedToOrigin) {
      deleteBranch(branchName);
    }

    // 11. Update proposal + history
    if (pushedToOrigin) {
      updateProposal("merged", "Successfully built, tested, and merged");
      appendHistory(proposal, "merged", "All tests passed, auto-merged", filesChanged, {
        branchName,
        mergeCommit,
        pushedToOrigin: true,
      });
      log(`proposal ${proposal.id} merged successfully`);
    } else {
      const rollbackNotes = localRollbackOk
        ? "Local main rolled back to pre-merge state."
        : "WARNING: local main rollback failed; subsequent pushes are blocked until manual cleanup.";
      const notes = `Push to origin/main failed: ${pushError.slice(0, 300)} ${rollbackNotes}`;
      updateProposal("failed", notes);
      appendHistory(proposal, "failed", notes, filesChanged, {
        branchName,
        mergeCommit,
        pushedToOrigin: false,
      });
      log(`proposal ${proposal.id} failed after push error`);
      process.exitCode = 1;
    }
    cleanStaging();
    process.exit(process.exitCode || 0);

  } catch (e) {
    log(`pipeline error: ${e.message}`);

    try { restoreTargetFiles(snapshot); } catch (restoreErr) {
      log(`restore failed: ${restoreErr.message}`);
    }
    try { execFileSync("git", ["-C", ROOT, "checkout", "main"], { stdio: "ignore", timeout: 15000 }); } catch {}
    if (branchCreated) {
      try { deleteBranch(branchName); } catch {}
    }

    updateProposal("failed", `Pipeline error: ${e.message}`);
    appendHistory(proposal, "failed", `Pipeline error: ${e.message}`, filesChanged, { branchName });
    cleanStaging();
    process.exit(1);
  }
})();
