# Hunter — Architecture & Migration Reference

*Last updated: 2026-04-10*

---

## System Overview

Sebastian D. Hunter is an autonomous X/Twitter agent that browses, journals,
forms beliefs, and posts — with a permanently verifiable public record on Arweave.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GCP VM (sebastian)                           │
│                                                                     │
│  run.sh (cron, every ~40 min)                                       │
│    │                                                                │
│    ├── Browse cycle (x-hunter agent)                                │
│    │     └── gemini_agent.js  ──► Vertex AI (Gemini 2.5-flash)     │
│    │           ├── browse X via Chrome CDP (:18801)                 │
│    │           ├── journal to journals/<date>_<hour>.html           │
│    │           └── tools: memory_recall, search, post, quote...     │
│    │                                                                │
│    └── post_browse.js (pipeline after each browse cycle)            │
│          ├── 4a. apply_claim_tracker_delta.js                       │
│          ├── 4b. signal_detector.js                                 │
│          ├── 4c. post signal tweet (if signal_draft.txt)            │
│          ├── 4d. predictive_prompt.js                               │
│          ├── 4d-post. post prediction tweet                         │
│          ├── 4e. verify_claims.js (or Cloud Tasks → verify worker)  │
│          ├── 4f. verification data export (no auto-tweet)           │
│          └── 4g. post landmark special tweet (if draft exists)      │
│                                                                     │
│  Daily maintenance (run.sh, 1×/day)                                 │
│    ├── decision.js          — daily belief checkpoint               │
│    ├── sprint_manager.js    — sprint lifecycle (Postgres)           │
│    ├── write_article.js     — long-form article draft               │
│    ├── cluster_axes.js      — detect redundant belief axes          │
│    └── curiosity.js         — pick next research directive          │
│                                                                     │
│  Occasional scripts                                                 │
│    ├── landmark/index.js    — landmark event detection + publish    │
│    ├── external_source_discovery.js — build external source map     │
│    ├── backfill_embeddings.js — fill embedding gaps                 │
│    └── comment_candidates.js — proactive comment scoring            │
└─────────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌──────────────────┐         ┌──────────────────────┐
│  Cloud SQL       │         │  Cloud Run workers    │
│  (Postgres)      │         │                       │
│  - memory        │         │  hunter-verify        │
│  - posts         │  Pub/Sub │    └── verify_claims  │
│  - embeddings    │◄────────│        + web_search   │
│  - claim_verif.  │         │                       │
│  - sprint data   │         │  hunter-publish       │
│  - pending_drafts│         │    └── verification_  │
└──────────────────┘         │        export.json    │
                             │        → GCS          │
                             └──────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────┐
│  Cloud Storage (GCS)                                 │
│    state/verification_export.json → web/lib/reader  │
│    (future: journal exports, landmark manifests)     │
└──────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────┐
│  Next.js website (Cloud Run: sebastian-web)          │
│    /                — homepage / recent posts        │
│    /journals        — browse cycle journals          │
│    /ontology        — live belief axes               │
│    /checkpoints     — daily belief snapshots         │
│    /articles        — long-form pieces               │
│    /ponders         — ponder deep-dives              │
│    /plan            — active sprint plan             │
│    /verified        — claim verification page        │
│    /about           — who Sebastian is               │
└──────────────────────────────────────────────────────┘
```

---

## Database Architecture

### SQLite → Postgres Migration

The VM runner was built on SQLite (`better-sqlite3`, synchronous API).
Cloud Run workers and scale-out require Postgres. The migration uses a
feature-flag pattern: if `DATABASE_URL` is set, async `.pg.js` modules
are loaded; otherwise the synchronous SQLite modules run unchanged.

```
runner/lib/db_backend.js
  │
  ├── loadScraperDb()
  │     DATABASE_URL → scraper/db.pg.js   (async, pg Pool)
  │     else         → scraper/db.js      (sync, better-sqlite3)
  │
  ├── loadIntelligenceDb()
  │     DATABASE_URL → runner/intelligence/db.pg.js
  │     else         → runner/intelligence/db.js
  │
  ├── loadSprintDb()
  │     DATABASE_URL → runner/sprint/db.pg.js
  │     else         → runner/sprint/db.js
  │
  └── loadVerificationDb()
        DATABASE_URL → runner/intelligence/verification_db.pg.js
        else         → runner/intelligence/verification_db.js
```

**Key difference:** All methods on `.pg.js` instances are `async` and
return Promises. Callers must `await` every db call.

### Tables (Cloud SQL)

| Table | Module | Purpose |
|---|---|---|
| `posts` | scraperDb | Scraped X posts + score + keywords |
| `memory` | scraperDb | Journals, checkpoints, articles (FTS5/GIN indexed) |
| `embeddings` | scraperDb | 768-dim Gemini vectors for semantic recall |
| `sources` | intelligenceDb | Source credibility tiers + NewsGuard scores |
| `claims` | intelligenceDb | Extracted claims (intelligence pipeline) |
| `claim_verifications` | verificationDb | Scored + verified claims, 18 seeded |
| `claim_audit_log` | verificationDb | Status transition audit trail |
| `plans` | sprintDb | 30-day strategic plans |
| `sprints` | sprintDb | Weekly sprint breakdown |
| `tasks` | sprintDb | Sprint tasks with signal matching |
| `accomplishments` | sprintDb | Evidence of progress |
| `pending_drafts` | (direct) | Tweet drafts queued for posting |

---

## Async Migration Log

All 11 runner scripts that bypassed `db_backend.js` have been migrated.

### Phase 1 — Critical browse loop (2026-04-09)

| File | Change |
|---|---|
| `runner/lib/fts_maintain.js` | `loadScraperDb()`, async IIFE |
| `runner/recall.js` | `loadScraperDb()`, async semanticRecall, `await db.raw().query()` |
| `runner/archive.js` | `loadScraperDb()`, all db calls awaited |
| `runner/moltbook.js` | `loadScraperDb()`, recallForComment made async |
| `runner/sprint_manager.js` | `loadSprintDb()`, all sprintDb calls awaited |

### Phase 2 — Remaining scripts (2026-04-10)

| File | DB methods migrated |
|---|---|
| `runner/comment_candidates.js` | `recentPosts`, `recallMemory` — wrapped in async IIFE |
| `runner/apply_claim_tracker_delta.js` | `getPostById` — `inferClaimAttribution` made async |
| `runner/write_article.js` | `recentMemory`, `recallMemory` |
| `runner/backfill_embeddings.js` | `embeddedIds`, `storeEmbedding`, `db.raw().query()` |
| `runner/cluster_axes.js` | `getEmbedding`, `storeEmbedding` |
| `runner/curiosity.js` | `topKeywords` |
| `runner/external_source_discovery.js` | `getPostById` — `collectFromClaims` + `main` made async |

**Pattern for `db.raw()` calls:**

```js
// Before (SQLite):
const _db = db.raw();
const rows = _db.prepare("SELECT id, text FROM memory ORDER BY id").all();

// After (Postgres):
const _db = db.raw();                              // returns pg Pool
const { rows } = await _db.query("SELECT id, text FROM memory ORDER BY id");
```

---

## Claim Verification Pipeline

```
Browse cycle → apply_claim_tracker_delta.js
                  └── claim_tracker.json (18+ claims)
                              │
              post_browse.js 4e
                  │
                  ├── Cloud Tasks enabled?
                  │     yes → enqueue → hunter-verify (Cloud Run)
                  │     no  → run verify_claims.js inline
                  │
              verify_claims.js
                  ├── load unverified/contested claims
                  ├── enrich with source data (source_registry.json / sources table)
                  ├── score all claims via claim_scorer.js
                  │     source_tier (30%) + newsguard (15%) + corroboration (20%)
                  │     + evidence_quality (15%) + cross_source (10%) + web_search (10%)
                  ├── top 1 claim → webSearchVerify() via Vertex AI
                  ├── update claim_tracker.json + claim_verifications table
                  ├── write claim_audit_log entry
                  └── if resolved → write state/verification_draft.txt
                                    write state/verification_export.json
                                    (tweet posting disabled — export powers /verified page)
```

**Status thresholds:**
- `>= 0.75` + web search confirms → `supported`
- `<= 0.25` or web search refutes → `refuted`
- Contradictions present → `contested`
- Otherwise → `unverified`

**Claim lifecycle expiry:**
- Breaking/military: 72h
- Diplomatic: 7d
- Structural: 30d

---

## Landmark Pipeline

```
run.sh (weekly or on-demand)
  └── landmark/index.js
        ├── 1. detect — scan DB for landmark events (signalCount, crossCluster, multiAxis)
        ├── 2. dedup  — cooldown + keyword dedup check
        ├── 3. editorial — generateEditorial() → headline + lead + full article
        ├── 4. art    — generateHeroArt() via Imagen (optional, non-fatal)
        ├── 5. publish — postArticle() → X Article with cover image
        ├── 6. record — recordLandmark(), save manifest.json + editorial.html
        └── 7. special — if stage == special_vocation | special_prediction:
                          write state/landmark_special_draft.txt
                          ↓
                post_browse.js 4g → postLandmarkSpecialTweet() → X post
```

**Tier model:**

| Stage | Tier | Edition supply | Trigger |
|---|---|---|---|
| `candidate` | — | — | Internal only, no publish |
| `article` | tier_2 | 30 | signalCount ≥ 4, crossCluster, coherence ≥ 0.55 |
| `mint` | tier_1 | 15 | signalCount ≥ 5, multiAxis, coherence ≥ 0.72 + editorial validation |
| `special_vocation` | special | 3 | Vocation axis reaches conviction threshold |
| `special_prediction` | special | 1 | Retroactively validated structural prediction |

NFT minting is preserved in code but disabled in the orchestrator (mint step commented out).

---

## Infrastructure

### Cloud Run Services

| Service | URL | Purpose |
|---|---|---|
| `sebastian-web` | sebastianhunter.fun | Next.js website |
| `hunter-verify` | (internal) | Claim verification worker |
| `hunter-publish` | (internal) | Verification export + tweet draft storage |

### Cloud Scheduler

| Job | Schedule | Target |
|---|---|---|
| verify-claims-schedule | Every 2h | hunter-verify /verify-cycle |
| export-verification | Every 6h | hunter-publish /export |

### Pub/Sub

`claim-resolved` topic → `hunter-publish` push subscription
Fired when a claim changes status to `supported` or `refuted`.

### CI/CD

`.github/workflows/deploy.yml` — deploys on push to `main`:
- Changes to `web/**` → rebuild + deploy `sebastian-web`
- Changes to `workers/verify/**` → rebuild + deploy `hunter-verify`
- Changes to `workers/publish/**` → rebuild + deploy `hunter-publish`

VM runner deploys via `git pull` on the VM (no CI for runner scripts).

---

## Semantic Embeddings

```
Gemini text-embedding-004 (768-dim) via Vertex AI
  ↓
embeddings table: entity_type ('memory' | 'post' | 'axis') + entity_id + vector (JSON)
  ↓
scraper/embed.js → db.storeEmbedding() / db.getEmbedding() / db.allEmbeddings()
  ↓
Used by: recall.js (semantic memory recall), cluster_axes.js (axis dedup)
```

Backfill status: 214/792 memory rows embedded (as of 2026-04-05).
Run `node runner/backfill_embeddings.js` on the VM to fill gap.

---

## Key State Files

| File | Written by | Read by |
|---|---|---|
| `state/ontology.json` | apply_ontology_delta.js | every browse cycle |
| `state/claim_tracker.json` | apply_claim_tracker_delta.js | verify_claims.js |
| `state/verification_export.json` | verify_claims.js / publish worker | web /verified page |
| `state/signal_draft.txt` | signal_detector.js | post_browse.js 4c |
| `state/prediction_draft.txt` | predictive_prompt.js | post_browse.js 4d-post |
| `state/verification_draft.txt` | verify_claims.js | (disabled) |
| `state/landmark_special_draft.txt` | landmark/index.js step 7 | post_browse.js 4g |
| `state/sprint_context.txt` | sprint_manager.js | run.sh → tweet prompt |
| `state/sprint_snapshot.json` | sprint_manager.js | web /plan page |
| `state/curiosity_directive.txt` | curiosity.js | browse cycle agent |
| `state/comment_candidates.txt` | comment_candidates.js | browse cycle agent |

---

## LLM Budget (approximate, per browse cycle)

| Call | Model | Tokens est. |
|---|---|---|
| Browse agent loop (2-4 turns) | Gemini 2.5-flash (Vertex) | ~8k |
| verify_claims.js web search | Gemini 2.5-flash (Vertex) | ~3k |
| signal_detector.js | Gemini 2.5-flash (Vertex) | ~2k |
| voice_filter.js | Gemini 2.5-flash (Vertex) | ~1k |
| curiosity.js LLM (every 12 cycles) | Ollama qwen2.5:7b (local) | local |
| cluster_axes.js embedding | Gemini text-embedding-004 | ~500 |

Daily (24 cycles): ~340k tokens via Vertex AI + local Ollama calls.
