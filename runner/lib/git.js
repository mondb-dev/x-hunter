'use strict';

/**
 * runner/lib/git.js — git commit/push + Vercel deploy helpers
 *
 * Ported 1:1 from run.sh:
 *   - git add/commit/push    lines 789-795 (tweet cycle), 955-960 (daily)
 *   - Vercel deploy hook      lines 797-800 (tweet cycle), 962-964 (daily)
 *
 * All operations are synchronous to match bash behavior.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const config = require('./config');

// Lazy-load to avoid circular dependency
let _notify;
function getNotify() {
  if (!_notify) _notify = require('./notify');
  return _notify;
}

function log(msg) {
  console.log(`[git] ${msg}`);
}

// ── commitAndPush ────────────────────────────────────────────────────────────
/**
 * git add + commit + push with configurable paths and message.
 * Bash: git -C "$PROJECT_ROOT" add journals/ checkpoints/ state/ articles/ daily/ ponders/
 *       git -C "$PROJECT_ROOT" commit -m "cycle ${CYCLE}: ${TODAY} ${NOW}"
 *       git -C "$PROJECT_ROOT" push origin main
 *
 * Each command ignores errors to match `2>/dev/null || true`.
 *
 * @param {Object} opts
 * @param {string[]} opts.paths - relative paths to add (e.g. ['journals/', 'state/'])
 * @param {string} opts.message - commit message
 */
function commitAndPush({ paths, message }) {
  const root = config.PROJECT_ROOT;
  const addPaths = paths.join(' ');
  try {
    execSync(`git -C "${root}" add ${addPaths}`, { stdio: 'ignore' });
  } catch {}
  try {
    execSync(`git -C "${root}" commit -m "${message}"`, { stdio: 'ignore' });
  } catch {}
  let pushOk = true;
  let pushErr = '';
  if (hasUnpublishedFailedMetaMerge()) {
    pushOk = false;
    pushErr = 'blocked: local main still contains a failed META merge that was never pushed';
  }
  try {
    if (pushOk) {
      execSync(`git -C "${root}" push origin main`, { stdio: 'pipe', timeout: 30000 });
    }
  } catch (e) {
    pushOk = false;
    pushErr = e.stderr ? e.stderr.toString().trim() : e.message;
  }
  try { getNotify().checkGitPush(pushOk, pushErr); } catch {}
  log(pushOk ? 'push done' : `push failed: ${pushErr.slice(0, 120)}`);
}

function hasUnpublishedFailedMetaMerge() {
  const historyPath = config.PROPOSAL_HISTORY_PATH;
  try {
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    const proposals = Array.isArray(history.proposals) ? history.proposals : [];
    for (let i = proposals.length - 1; i >= 0; i--) {
      const p = proposals[i];
      if (p.pushed_to_origin !== false || !p.merge_commit || p.reverted) continue;
      try {
        execFileSync('git', ['-C', config.PROJECT_ROOT, 'merge-base', '--is-ancestor', p.merge_commit, 'HEAD'], {
          stdio: 'ignore',
          timeout: 10000,
        });
        return true;
      } catch (e) {
        if (e.status === 1) {
          continue;
        }
      }
    }
  } catch {}
  return false;
}

// ── triggerVercelDeploy ──────────────────────────────────────────────────────
/**
 * POST to the Vercel deploy hook URL if configured.
 * Bash: curl -s -X POST "$VERCEL_DEPLOY_HOOK" > /dev/null 2>&1 || true
 *
 * @param {string} [hookUrl] - VERCEL_DEPLOY_HOOK env value (may be undefined)
 */
function triggerVercelDeploy(hookUrl) {
  if (!hookUrl) return;
  try {
    execSync(`curl -s -X POST "${hookUrl}"`, { stdio: 'ignore', timeout: 15000 });
    log('Vercel deploy hook triggered');
  } catch {}
}

// ── generateManifests ────────────────────────────────────────────────────────
/**
 * Write articles/manifest.json and journals/manifest.json so the web app can
 * list files without relying on GCS FUSE directory listing cache (which is
 * stale for up to 60s after new files land in GCS).
 *
 * Each manifest: { generated: ISO string, files: string[] } — sorted newest-first.
 * The web readers fall back to readdirSync if manifests are missing.
 */
function generateManifests() {
  const root = config.PROJECT_ROOT;

  // Articles: YYYY-MM-DD.md
  try {
    const articlesDir = path.join(root, 'articles');
    if (fs.existsSync(articlesDir)) {
      const files = fs.readdirSync(articlesDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}[^/]*\.md$/.test(f))
        .sort()
        .reverse();
      fs.writeFileSync(
        path.join(articlesDir, 'manifest.json'),
        JSON.stringify({ generated: new Date().toISOString(), files }, null, 2),
      );
    }
  } catch (err) {
    log(`manifest generation (articles) error: ${err.message}`);
  }

  // Journals: YYYY-MM-DD_HH.html
  try {
    const journalsDir = path.join(root, 'journals');
    if (fs.existsSync(journalsDir)) {
      const files = fs.readdirSync(journalsDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f))
        .sort()
        .reverse();
      fs.writeFileSync(
        path.join(journalsDir, 'manifest.json'),
        JSON.stringify({ generated: new Date().toISOString(), files }, null, 2),
      );
    }
  } catch (err) {
    log(`manifest generation (journals) error: ${err.message}`);
  }
}

// ── redeployWeb ──────────────────────────────────────────────────────────────
/**
 * Force a new Cloud Run revision for sebastian-web by updating LAST_SYNC env var.
 * The new pod gets a fresh GCS FUSE mount and immediately sees all synced files.
 * Runs with --async so the runner is not blocked while the revision rolls out.
 */
function redeployWeb() {
  const project = process.env.GCP_PROJECT || 'sebastian-hunter';
  const region  = process.env.GCP_REGION  || 'us-central1';
  const ts = Date.now().toString();
  // Use the Compute Engine default SA which has roles/editor (Cloud Run included).
  // The VM's gcloud active account may be a different SA without run.services.update.
  const account = '362753554748-compute@developer.gserviceaccount.com';
  try {
    execSync(
      `gcloud run services update sebastian-web` +
      ` --update-env-vars LAST_SYNC=${ts}` +
      ` --region ${region}` +
      ` --project ${project}` +
      ` --account ${account}` +
      ` --async` +
      ` --quiet`,
      { stdio: 'ignore', timeout: 30000 },
    );
    log('Cloud Run redeploy triggered (async)');
  } catch (err) {
    log(`Cloud Run redeploy error: ${err.message}`);
  }
}

// ── syncToGCS ───────────────────────────────────────────────────────────────
/**
 * Sync state/journals/checkpoints/articles/daily/ponders/landmarks to GCS bucket,
 * then trigger a Cloud Run redeploy so the new pod picks up all fresh files.
 */
function syncToGCS() {
  const bucket = process.env.GCS_DATA_BUCKET || 'sebastian-hunter-data';
  const root = config.PROJECT_ROOT;
  const dirs = ['state', 'journals', 'checkpoints', 'articles', 'daily', 'ponders', 'landmarks'];
  try {
    generateManifests();
    for (const d of dirs) {
      const src = path.join(root, d);
      if (fs.existsSync(src)) {
        execSync(`gsutil -m -q rsync -r "${src}/" "gs://${bucket}/${d}/"`, {
          stdio: 'ignore', timeout: 120000, cwd: root,
        });
      }
    }
    log('GCS data sync complete');
  } catch (err) {
    log(`GCS sync error: ${err.message}`);
  }
}

// ── Branch management (META cycle) ──────────────────────────────────────────

/**
 * Create a new branch from current HEAD and switch to it.
 * @param {string} branch - branch name (e.g. 'meta/proposal_xyz_123')
 */
function createBranch(branch) {
  const root = config.PROJECT_ROOT;
  execSync(`git -C "${root}" checkout -b "${branch}"`, { stdio: 'pipe', timeout: 15000 });
  log(`branch created: ${branch}`);
}

/**
 * Merge a branch into main using --no-ff (preserves merge commit for easy revert).
 * Switches to main first, then merges.
 * @param {string} branch - branch to merge
 */
function mergeBranch(branch) {
  const root = config.PROJECT_ROOT;
  execSync(`git -C "${root}" checkout main`, { stdio: 'pipe', timeout: 15000 });
  execSync(`git -C "${root}" merge "${branch}" --no-ff -m "Merge ${branch}"`, {
    stdio: 'pipe', timeout: 30000,
  });
  log(`merged ${branch} into main`);
}

/**
 * Delete a local branch (force). Safe to call even if branch doesn't exist.
 * Ensures we're on main first.
 * @param {string} branch - branch to delete
 */
function deleteBranch(branch) {
  const root = config.PROJECT_ROOT;
  try { execSync(`git -C "${root}" checkout main`, { stdio: 'ignore', timeout: 15000 }); } catch {}
  try {
    execSync(`git -C "${root}" branch -D "${branch}"`, { stdio: 'pipe', timeout: 15000 });
    log(`branch deleted: ${branch}`);
  } catch {}
}

/**
 * Commit changes on the current (feature) branch.
 * Does NOT push — the merge to main handles push.
 * @param {Object} opts
 * @param {string} opts.branch - branch name (for logging)
 * @param {string[]} opts.paths - relative paths to add
 * @param {string} opts.message - commit message
 */
function commitAndPushBranch({ branch, paths, message }) {
  const root = config.PROJECT_ROOT;
  const cleanPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (cleanPaths.length === 0) {
    throw new Error(`No paths provided for commit on ${branch}`);
  }
  try {
    execFileSync('git', ['-C', root, 'add', '--', ...cleanPaths], {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch (e) {
    throw new Error(`git add failed on ${branch}: ${e.message}`);
  }

  let hasStagedChanges = false;
  try {
    execFileSync('git', ['-C', root, 'diff', '--cached', '--quiet', '--', ...cleanPaths], {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch (e) {
    if (e.status === 1) {
      hasStagedChanges = true;
    } else {
      throw new Error(`git diff --cached failed on ${branch}: ${e.message}`);
    }
  }

  if (!hasStagedChanges) {
    throw new Error(`No staged changes to commit on ${branch}`);
  }

  const safeMsg = String(message || '').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (!safeMsg) {
    throw new Error(`Empty commit message for ${branch}`);
  }

  try {
    execFileSync('git', ['-C', root, 'commit', '-m', safeMsg], {
      stdio: 'pipe',
      timeout: 15000,
    });
    const commitHash = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    log(`committed on ${branch}: ${safeMsg}`);
    return { commitHash };
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`commit failed on ${branch}: ${stderr.slice(0, 200)}`);
  }
}

/**
 * Revert a specific merge commit on main. Used by watchdog auto-revert.
 * @param {string} commitHash - the merge commit hash to revert (NOT HEAD — other commits may exist after it)
 * Returns true if revert succeeded.
 */
function revertLastMerge(commitHash) {
  const root = config.PROJECT_ROOT;
  if (!commitHash || !/^[0-9a-f]{7,40}$/i.test(commitHash)) {
    log('revertLastMerge: invalid or missing commit hash — aborting');
    return false;
  }
  try {
    // -m 1 tells git to use the first parent (main) as the mainline
    execSync(`git -C "${root}" revert ${commitHash} -m 1 --no-edit`, { stdio: 'pipe', timeout: 30000 });
    execSync(`git -C "${root}" push origin main`, { stdio: 'pipe', timeout: 30000 });
    log(`reverted merge commit ${commitHash} and pushed`);
    return true;
  } catch (e) {
    log(`revert failed for ${commitHash}: ${e.message}`);
    return false;
  }
}

/**
 * Get the last merge commit hash on main (for tracking meta merges).
 * Returns { hash, message } or null.
 */
function lastMergeCommit() {
  const root = config.PROJECT_ROOT;
  try {
    const out = execSync(
      `git -C "${root}" log --merges --oneline -1`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    if (!out) return null;
    const [hash, ...rest] = out.split(' ');
    return { hash, message: rest.join(' ') };
  } catch {
    return null;
  }
}

module.exports = {
  commitAndPush,
  triggerVercelDeploy,
  syncToGCS,
  redeployWeb,
  createBranch,
  mergeBranch,
  deleteBranch,
  commitAndPushBranch,
  revertLastMerge,
  lastMergeCommit,
};
