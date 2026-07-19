# Architecture — see ../ARCHITECTURE.md

The canonical system architecture lives at the repo root:
**[ARCHITECTURE.md](../ARCHITECTURE.md)** (layers, cycle anatomy, algorithms,
posting pipeline, stability). Code-anchored constants and schedules:
**[INVENTORY.md](INVENTORY.md)**.

This file keeps only the cloud-worker reference that is not covered there.

## Cloud Run Services

| Service | Purpose |
|---|---|
| `hunter-verify` | Claim verification worker (Gemini 2.5 Flash via Vertex — the one place Gemini still does inference) |
| `hunter-publish` | Verification export + draft storage |
| `hunter-memory` | Memory API worker (`workers/memory`, `MEMORY_API_KEY`) |

The website (`sebastianhunter.fun`) is hosted on **Vercel**, not Cloud Run —
built from repo content via `web/scripts/prebuild.js`. No GCS is involved.

### Cloud Scheduler

| Job | Schedule | Target |
|---|---|---|
| verify-claims-schedule | Every 2h | hunter-verify /verify-cycle |
| export-verification | Every 6h | hunter-publish /export |

### Pub/Sub

`claim-resolved` topic → `hunter-publish` push subscription.
Fired when a claim changes status to `supported` or `refuted`.

### CI/CD

`.github/workflows/deploy.yml` — on push to `main`:
- `web/**` → Vercel rebuilds the site (Vercel GitHub integration)
- `workers/verify/**` → rebuild + deploy `hunter-verify`
- `workers/publish/**` → rebuild + deploy `hunter-publish`

The runner itself deploys by `git pull` on the local machine (no CI).

## Historical note

The SQLite→Postgres async-migration log, VM-era infrastructure notes, and the
old per-cycle LLM budget that used to live in this file described the
GCP-VM/Gemini era (pre-June 2026) and were removed in the 2026-07 docs sync.
The system now runs locally under launchd with a local qwen2.5-agent brain,
Claude-composed outbound prose, and nomic-embed-text embeddings — see the root
ARCHITECTURE.md and docs/INVENTORY.md.
