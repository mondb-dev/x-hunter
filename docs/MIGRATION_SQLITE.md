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

---

# Stability watch (do this for ~1–2 days before giving the Phase 5 go)

Goal: confirm the agent runs clean on SQLite before deleting Postgres. Run the daily health check below; everything green for ~2 days = safe to decommission.

**Daily health check (paste-ready):**
```bash
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap --command='
H=/home/raymond_d_baldonado_gmail_com/hunter; cd $H
echo "services:"; systemctl is-active sebastian-runner sebastian-browser sebastian-watchdog.timer | tr "\n" " "; echo
echo "last 3 cycles:"; tail -3 $H/runner/orchestrator.log | grep -oE "\"cycle\":[0-9]+,\"type\":\"[A-Z]+\",\"durationSec\":[0-9]+,.*\"postSuccess\":(true|false|null)"
echo "errors (should be empty):"; tail -400 $H/runner/runner.log | grep -iE "postgres|DATABASE_URL|ECONNREFUSED|no such table|SqliteError|FOREIGN KEY|relation .* does not" | tail -5
echo "export fresh:"; ls -la --time-style=+%m-%d_%H:%M $H/state/verification_export.json | awk "{print \$6}"
echo "SQLite growing (verifications):"; python3 -c "import sqlite3;print(sqlite3.connect(\"$H/state/intelligence.db\").execute(\"select count(*) from claim_verifications\").fetchone()[0])"
echo "git .git size + no db commits:"; du -sh $H/.git | cut -f1; git -C $H log -3 --name-only --pretty=format:%h | grep -E "\.db$" && echo "!! DB COMMITTED" || echo "  no db in commits OK"
'
```

**What healthy looks like:** services `active active active`; cycles completing with periodic `postSuccess:true`; **error grep EMPTY**; export timestamp advancing; `claim_verifications` count slowly rising (new claims scored into SQLite); `.git` ~350M and **no `.db` in commits**.

**Red flags → response:**
| Symptom | Meaning | Action |
|---|---|---|
| `postgres`/`ECONNREFUSED`/`DATABASE_URL` in errors | something still calling PG | find the script not going through `db_backend`; fix before decommission |
| `no such table` / `SqliteError` | a SQLite sibling missing a table | inspect which table; add create-if-not-exists |
| runner inactive or no new cycle >2h | hang | watchdog should auto-restart within 15min; else `sudo systemctl restart sebastian-runner` |
| `!! DB COMMITTED` | a `state/*.db` slipped back into git | confirm `.gitignore` has `state/*.db`; `git rm --cached` it |
| posting stopped but no errors | likely a voice/x_control/critique gate, not DB | not a migration issue |

**REVERT (only if SQLite proves broken):**
```bash
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap --command='
H=/home/raymond_d_baldonado_gmail_com/hunter
cp $H/.env.precutover $H/.env && sudo systemctl restart sebastian-runner'
```
→ restores `DATABASE_URL` + `MEMORY_API_URL` → back on Postgres. PG data is current (the verify worker kept writing it). The extra rows in SQLite are harmless.

---

# AI HANDOFF — executing Phase 5 (decommission) & Phase 6 (cleanup) when the go is given

**State you're inheriting:** cutover is DONE + verified. The agent runs on SQLite (`DATABASE_URL` + `MEMORY_API_URL` commented in VM `~/.env`, backup `~/.env.precutover`). Branch `consolidate-sqlite` is merged to `main`. Postgres (`sebastian-db`, public IP `35.223.112.4`) + Cloud Run workers (`hunter-verify`, `hunter-publish`, `hunter-memory`) + Cloud Scheduler + Pub/Sub still exist as the fallback. Do NOT start until the user explicitly says the stability window passed.

**VM access:** `gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap --command="…"` (always `--tunnel-through-iap`). Migrator is at `runner/intelligence/migrate_pg_to_sqlite.js`; run it with `DATABASE_URL` passed inline from `.env.precutover` (it's commented in live `.env`): `DBURL=$(grep '^#CUTOVER DATABASE_URL' ~/hunter/.env.precutover | sed 's/^#CUTOVER //;s/DATABASE_URL=//'); DATABASE_URL="$DBURL" node ...`.

**Phase 5 — decommission (IRREVERSIBLE; one step at a time, verify between):**
1. **Final sync:** the verify worker has been writing PG every 2h since cutover. Run `migrate_pg_to_sqlite.js --commit` once more (with DATABASE_URL inline) to pull those last rows into SQLite. Verify counts rose.
2. **Stop the inflow first:** pause/delete Cloud Scheduler jobs (`verify-claims-schedule`, `export-verification`) and Pub/Sub push subs (`claim-resolved-push`, `cycle-complete-push`) so nothing writes PG anymore.
3. **Backup Cloud SQL:** `gcloud sql export sql sebastian-db gs://… ` — NO GCS, so instead `pg_dump` to a local file on the VM and copy it off (or `gcloud sql backups create`). Keep the dump.
4. **Delete Cloud Run workers:** `gcloud run services delete hunter-verify hunter-publish hunter-memory --region=us-central1`.
5. **Delete Cloud SQL:** `gcloud sql instances delete sebastian-db` — this kills the public-IP/sslmode=disable security debt. Point of no return.
6. Verify the runner is unaffected (it doesn't touch any of these post-cutover).

**Phase 6 — repo cleanup (after Phase 5 only; `.pg.js` is the revert path so don't delete earlier):**
- `git rm`: all `*.pg.js` (`scraper/db.pg.js`, `runner/intelligence/{db,verification_db,interactions_db}.pg.js`, `runner/sprint/db.pg.js`), `runner/lib/pg.js`, `runner/intelligence/migrate_pg_to_sqlite.js` (one-off, done), `workers/` (verify/publish/memory), `web/Dockerfile` + `web/cloudbuild.yaml` (dead Cloud-Run/GCS-FUSE), the `deploy-web` job in `.github/workflows/deploy.yml` (dead — also flagged as task `task_19f5e050`).
- Collapse `runner/lib/db_backend.js` to SQLite-only (or delete it and have consumers require the SQLite modules directly).
- Remove `DATABASE_URL`/`MEMORY_API_URL`/pg/GCS from `.env.example` + scrub remaining refs in docs (`docs/ARCHITECTURE.md`, `docs/SYSTEM_DIAGRAM.md`) to a single-SQLite spine.
- Remove the now-dead `DATABASE_URL`/`MEMORY_API_URL` lines from the VM `.env` + `.env.precutover` once you're sure no revert is wanted.

**Gotchas already hit (so you don't repeat them):**
- VM `git pull` of the DB-untrack commit DELETES the working-tree `state/*.db` → **back them up before any VM pull/reset, restore after** (`/tmp/db_backup`).
- Migrator append must exclude autoincrement `id` (collision) — already fixed; relational sprint tables use `replace` with FK off.
- Deeply-nested `gcloud ssh --command="node -e \"…\""` quoting is fragile (the `$1`/`$()` escaping breaks silently) — prefer `scp` a script then run it, or pass values via inline env vars.
- The runner pushes to `main` every ~30min with `pull --rebase -Xtheirs`; expect to rebase your local before pushing.
