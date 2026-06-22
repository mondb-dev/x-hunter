# Migration: consolidate to SQLite single-spine (Option A)

**Goal:** retire the half-finished SQLite→Postgres split. Make SQLite (on the VM) the
single source of truth; fold the Cloud Run workers' logic onto the VM; decommission
Cloud SQL + workers. Reversible until Cloud SQL is deleted (Phase 5).

**Branch:** `consolidate-sqlite` (kept off `main` so the live VM doesn't pull it until cutover).

## Locked decisions (evaluated; best-recommendation)
- **Backend switch** = `DATABASE_URL` presence (set→Postgres `.pg.js`, unset→SQLite). Cutover = unset it.
- **Duplicated tables** (posts/keywords/accounts/embeddings/memory): SQLite already holds the full live copy → **discard the Postgres copies**, no migration.
- **PG-only data must be migrated** (else lost): claim_verifications, claim_audit_log, sources, sprints/tasks/accomplishments/plans/daily_logs, interactions, pending_drafts.
- **Merge rules** (SQLite intelligence.db/sprints.db already hold STALE pre-cutover rows; PG has been live):
  - verifications / audit / sprints / tasks / accomplishments / plans / daily_logs / interactions / pending_drafts → **Postgres wins** (newer).
  - `sources` → **UNION on `handle` (PK), PG wins on conflict** (SQLite has 1923 historical, PG has 948 live registry — keep both, prefer PG values). *Confirm before Phase 2.*
- **hunter-memory worker = the web's "ask Sebastian" read API.** Do NOT just drop it. **Re-host the same read API on the VM** (reads SQLite + 81k embeddings); repoint `MEMORY_API_URL`. Preserves the API capability; only loses Cloud Run autoscaling (fine at this scale).

## Phases
- [x] **Phase 0 — inventory & decisions** (done; see above + capacity check: e2-medium, 2vCPU/3.8GB near-idle, 15GB free — ample).
- [x] **Phase 1 — build missing SQLite pieces**
  - [x] `runner/intelligence/interactions_db.js` (SQLite sibling; FTS5; functional-tested ✓)
  - [x] `loadInteractionsDb()` added to `db_backend.js`; consumers (proactive_reply, agent_tools, scraper/reply) switched off hard `.pg` require
  - [x] confirmed SQLite targets exist: `verification_db.js` (claim_verifications PK=claim_id, claim_audit_log, claim_investigations), `intelligence/db.js` (sources PK=handle, claims), `sprint/db.js` (plans/sprints/tasks/accomplishments/daily_logs)
  - [x] `pending_drafts` decision: **skip** — publish-worker-transient (8 in-flight), no SQLite home; runner owns posting via state files
- [x] **Phase 2 — PG→SQLite merge migrator** ✅ built + dry-run validated on VM
  - migrator self-introspecting; DRY-RUN default; `--commit` / `--state <dir>`; embeds interactions schema (table+FTS+triggers) so it migrates + indexes
  - **Dry-run result (vs copies of real dbs + live PG), all clean, no data loss:**
    - claim_verifications [upsert/claim_id]: pg754 + sqlite52 → **763** (43 PG-wins overlaps, 9 sqlite-only kept)
    - sources [upsert/handle]: **1923** kept, 948 refreshed from PG
    - claim_audit_log [append]: 168 + 9736 → **9904**
    - interactions [append]: 0 + 393 → **393** (cols 10/11, excludes PG `tsv`)
    - sprints 20 / tasks 192 / accomplishments 963 / plans 6 / daily_logs 85 (append, dedup caught 4/40/81/0/28)
  - minor caveat: append on mutable sprint/task rows can leave a near-dupe if a row changed post-cutover; harmless at this volume (~20 sprints). Re-run `--commit` for the real write at cutover.
- [x] **Phase 3 — worker-logic coverage analyzed: NO folding code needed**
  - verify scoring (`daily.js`→`verify_claims.js`), export regen + verification posting (`post_verification.js` per browse cycle) **already run on the VM via `db_backend`** → switch to SQLite automatically at cutover. Cloud Run verify/publish workers are a **redundant parallel path** → decommission after cutover, nothing to fold.
  - runner memory: `sebastian_respond.recallViaMemoryAPI` returns null when `MEMORY_API_URL` unset → callers fall back to **local SQLite recall**. So decoupling the runner = just unset `MEMORY_API_URL` at cutover (no code).
  - **OPEN DECISION — `hunter-memory` web API:** `MEMORY_API_URL` IS set; the **web "ask Sebastian"** is the only true remote consumer (Vercel can't read VM SQLite). Options: (1) re-host on VM public endpoint (firewall+TLS+auth — infra exposure, outward-facing) ; (2) **[recommended]** let web Q&A go dormant at cutover, build the public "ask-the-AI" API later as a deliberate project (full 81k-embedding data, proper TLS/auth) — keeps the migration clean + reduces exposure ; (3) keep a minimal Cloud SQL alive just for memory+embeddings (defeats consolidation — not recommended).
- [~] **Phase 4 — cutover** ✅ executed
  - migrator `--commit` run on VM → SQLite now holds: claim_verifications 763, sources 1923, claim_audit_log 9923, interactions 393, plans 4, sprints 16, tasks 140, accomplishments 872, daily_logs 78
  - migrator fixes found during commit: exclude `id` on append (autoincrement collision); `INSERT OR IGNORE` for unique constraints; `replace` strategy for relational sprint tables (FK-safe, PG authoritative)
  - `.env`: commented `DATABASE_URL` + `MEMORY_API_URL` (backup `.env.precutover`); runner restarted, **active on SQLite, zero PG errors**, cycling
  - binary state DBs untracked+gitignored so they don't churn `.git`
  - [x] **VERIFIED:** post-cutover cycles complete; cycle 3024 TWEET `postSuccess=true` (agent posted at 09:32); zero PG/SQLite/FK errors; verification_export.json regenerated from SQLite (754 entries); git commits clean, no db bloat; all services active. **Final QA PASS — agent fully functional on SQLite.**
  - **revert** = uncomment the two .env vars + restart (PG still intact)
  - **NOTE:** Cloud Run verify worker still writes to PG every 2h until Phase 5 — do a final migrate sync right before deleting Cloud SQL.
- [ ] **Phase 5 — decommission** 🔒 *GATED — irreversible, needs explicit go + a stability window (~1–2 days running clean on SQLite first)*: do a **final `migrate --commit`** (the Cloud Run verify worker keeps writing PG every 2h until stopped) → backup Cloud SQL → delete Scheduler jobs, Pub/Sub, Cloud Run workers (verify/publish/memory), then the **Cloud SQL instance** (kills public-IP/sslmode debt). The web "ask Sebastian" goes dormant here (deferred per decision).
- [ ] **Phase 6 — repo cleanup** *(defer destructive parts until post-stability)*: deleting `*.pg.js`/`lib/pg.js` removes the easy PG-revert path, so do it only after Phase 5. Then: delete `workers/`, dead `deploy.yml` deploy-web job, `web/Dockerfile`+`cloudbuild.yaml`; collapse `db_backend`; strip DATABASE_URL/pg/GCS from `.env.example` + docs; update ARCHITECTURE/SYSTEM_DIAGRAM to single-spine.

## STATUS: cutover DONE + verified (2026-06-22). Agent live on SQLite, PG retained as fallback. Phases 5–6 gated on stability + explicit go.

## Findings / open items
- **Tracked binary DBs:** `state/{intelligence,sprints,verification,hunter}.db` (+ intelligence `-wal/-shm`) are committed to git. Dormant now; once Option A makes them live they'd churn `.git`. **Phase 6: untrack + gitignore them** (like `index.db`).
- **Reversibility:** nothing irreversible before Phase 5. Keep PG backup. Cutover is a one-line env revert.
