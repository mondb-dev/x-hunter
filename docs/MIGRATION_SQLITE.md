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
- [~] **Phase 2 — PG→SQLite merge migrator**
  - [x] built `runner/intelligence/migrate_pg_to_sqlite.js` — self-introspecting (discovers PG+SQLite cols at runtime, migrates intersection, JSON/ISO/bool coercion); DRY-RUN by default; `--commit`, `--state <dir>` for copies; strategies: `upsert` (claim_verifications/sources, PK-keyed, PG-wins) + `append` (audit_log/interactions/sprint tables, content-key dedup, never deletes); syntax-checked ✓
  - [ ] **run dry-run on the VM** (against live PG + the real SQLite dbs, read-only) → review counts/overlaps → tune strategies → then `--commit --state <copy>` and verify before cutover
- [ ] **Phase 3 — fold worker logic onto VM** (verify-cycle, /export, claim-resolved, interactions; **re-host memory API + repoint MEMORY_API_URL**; test with DATABASE_URL unset)
- [ ] **Phase 4 — cutover** (pause runner → re-run migrator for latest → unset DATABASE_URL → restart → verify full cycle, zero PG calls). *Reversible: re-set DATABASE_URL.*
- [ ] **Phase 5 — decommission** *(GATED on explicit go — irreversible)*: backup Cloud SQL, then delete Scheduler jobs, Pub/Sub, Cloud Run workers, **Cloud SQL instance** (kills public-IP/sslmode debt).
- [ ] **Phase 6 — repo cleanup**: delete `*.pg.js`, `lib/pg.js`, `workers/`, dead `deploy.yml` worker jobs, `web/Dockerfile`+`cloudbuild.yaml`; collapse `db_backend`; strip DATABASE_URL/pg/GCS from `.env.example` + docs; update ARCHITECTURE/SYSTEM_DIAGRAM.

## Findings / open items
- **Tracked binary DBs:** `state/{intelligence,sprints,verification,hunter}.db` (+ intelligence `-wal/-shm`) are committed to git. Dormant now; once Option A makes them live they'd churn `.git`. **Phase 6: untrack + gitignore them** (like `index.db`).
- **Reversibility:** nothing irreversible before Phase 5. Keep PG backup. Cutover is a one-line env revert.
