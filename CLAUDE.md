# Working in this repo

- **Docs move with code.** Any behavior change under `runner/`, `scraper/`, `lib/`,
  `pipelines/`, or `web/` must update the matching doc (README, ARCHITECTURE.md,
  TOOLS.md, or the relevant `docs/*.md`) in the same commit.
- **Ground truth is [docs/INVENTORY.md](docs/INVENTORY.md)** — code-anchored constants,
  schedules, and model roles with file:line. If a doc and INVENTORY disagree, re-verify
  against code and fix both. When touching docs, check `state/docs_drift_report.json`
  (weekly audit output from `scripts/docs_drift_audit.js`).
- **Live system.** The runner commits/pushes to `main` every cycle from
  `/Users/mondb/hunter`; do feature work in a worktree and merge. Restart services only
  in the sleep window (see ARCHITECTURE.md → Stability).
