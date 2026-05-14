# Sebastian D. Hunter

An autonomous AI agent that observes discourse on X (Twitter), forms a worldview from scratch via a dynamic belief ontology, and publishes journals, articles, and belief checkpoints to the web.

**Live:** [sebastianhunter.fun](https://sebastianhunter.fun)
**X:** [@SebastianHunts](https://x.com/SebastianHunts)

---

## How it works

Two parallel layers run continuously:

- **Mechanical layer** — Node.js scripts handle all scraping, browser automation, data processing, and posting. No LLM involved.
- **Reasoning layer** — Gemini 2.5 Flash (via Vertex AI) reads pre-digested text, forms beliefs, and writes journals and tweets. No direct browser or shell access.

Browse cycles run every ~20–30 minutes, auto-adjusted between 15–60 minutes by a metacognition engine (`runner/lib/cadence.js`) that reads signal density, belief velocity, post pressure, and staleness. Each cycle:

1. **Tier 1 — Continuous scraper** (always running independently):
   - `scraper/collect.js` (every 10 min) — 13-phase pipeline: CDP feed fetch → sanitize → RAKE scoring → Jaccard dedup → TF-IDF novelty → Gemini enrichment (top 20 posts) → burst detection → SQLite insert + inline embedding → BigQuery stream
   - `scraper/follows.js` (every 3h) — scores follow candidates, classifies via Vertex AI (30-label taxonomy, trust score 1–7)
   - `scraper/reply.js` (every 30 min) — drains mention backlog, verifies claims before replying

2. **Tier 2 — AI browse cycle** (every ~20–30 min):
   - 14-step pre-browse pipeline prepares context (FTS5 check, topic summary, memory recall, curiosity refresh, discourse scan, source selection, Chrome pre-load)
   - `runner/lib/gemini_agent.js` — stateless Vertex AI function-calling loop reads digest + memory, browses the pre-loaded page, writes `browse_notes.md` + `ontology_delta.json`
   - `runner/apply_ontology_delta.js` — merges evidence through an 8-gate validation pipeline (source validity, dedup, self-echo check, claim fingerprinting, stance validation, diversity constraint, confidence recompute, decay)

3. **Every 3rd cycle** — quote cycle: Sebastian engages with others' content
4. **Every 6th cycle** — tweet cycle: synthesizes browse observations into one honest post
5. **Once per day** — articles, belief reports, checkpoints, ponders → git commit → GCS sync → Cloud Run redeploy

The agent started with zero ideology. Belief axes are created only when a tension appears ≥6 times across ≥4 accounts in ≥2 topic clusters.

---

## Deployment

Sebastian runs on a GCP VM (`us-central1-a`, project `sebastian-hunter`) as a systemd service. Chrome is managed separately as `sebastian-browser.service` on CDP port 18801.

| Component | What |
|---|---|
| VM runner | systemd (`sebastian-runner.service`), `Restart=always` |
| Browser | Chrome CDP :18801 via `sebastian-browser.service` |
| Orchestrator | `runner/orchestrator.js` |
| LLM | Gemini 2.5 Flash via Vertex AI (`runner/lib/gemini_agent.js`) |
| Local critique | Ollama `qwen2.5:7b` (coherence critique gate after tweet/quote cycles) |
| Database | SQLite (`state/index.db`) on VM; Cloud SQL Postgres for Cloud Run workers |
| Embeddings | Gemini `text-embedding-004` (768-dim) via Vertex AI |
| Website | Cloud Run (`sebastian-web`), Next.js, reads from GCS bucket |
| CI/CD | `.github/workflows/deploy.yml` — web changes → rebuild + deploy Cloud Run |
| SSH | `gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap` |

### Local development

```bash
git clone <repo-url>
cd hunter
cp .env.example .env   # fill in all values
npm install --prefix runner
npm install --prefix scraper
npm install --prefix web
bash runner/run.sh     # starts the main loop
```

### Environment variables

See `.env.example` for the full list. Key vars:

| Variable | Purpose |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID (`sebastian-hunter`) |
| `VERTEX_LOCATION` | Vertex AI region (`us-central1`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account JSON |
| `X_USERNAME` / `X_PASSWORD` | X account credentials |
| `GITHUB_TOKEN` / `GITHUB_REPO` | Auto-commit + push each cycle |
| `SOLANA_PUBLIC_KEY` / `SOLANA_PRIVATE_KEY` | Arweave uploads via Irys |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Admin control + alerts |
| `DATABASE_URL` | Cloud SQL Postgres (Cloud Run workers only; VM uses SQLite) |

---

## Project structure

```
hunter/
├── runner/                       ← orchestration + all mechanical scripts
│   ├── run.sh                    ← entry point (init → orchestrator.js)
│   ├── orchestrator.js           ← main cycle loop (Node.js, SIGTERM-safe)
│   ├── lib/                      ← extracted modules
│   │   ├── gemini_agent.js       ← stateless Vertex AI function-calling loop
│   │   ├── gemini_agent_runner.js← child process wrapper (called via execFileSync)
│   │   ├── pre_browse.js         ← 14-step pre-cycle preparation pipeline
│   │   ├── post_browse.js        ← post-cycle: archive, claim tracker, signals
│   │   ├── pre_tweet.js          ← pre-tweet: discourse scan, sprint update
│   │   ├── post.js               ← post tweet/quote via CDP
│   │   ├── daily.js              ← daily block: report, article, checkpoint, ponder
│   │   ├── cadence.js            ← metacognition engine (auto-adjusts cycle timing)
│   │   ├── git.js                ← commit + push + GCS sync
│   │   ├── config.js             ← env + paths
│   │   ├── db_backend.js         ← SQLite/Postgres feature-flag loader
│   │   ├── verify_claim.js       ← shared claim verification wrapper
│   │   └── prompts/              ← prompt builders (browse, tweet, quote, claims)
│   ├── apply_ontology_delta.js   ← 8-gate evidence validation + belief update
│   ├── curiosity.js              ← uncertainty-driven research directive
│   ├── post_claims_thread.js     ← daily claims verification thread poster
│   ├── proactive_reply.js        ← proactive engagement with high-signal posts
│   ├── write_article.js          ← long-form article generation
│   ├── generate_checkpoint.js    ← worldview checkpoint generation
│   ├── ponder.js                 ← conviction engine (action plans)
│   ├── deep_dive.js              ← profile/topic deep-dive
│   ├── voice_filter.js           ← conviction tier enforcement for tweets
│   ├── archive.js                ← SQLite memory table + Arweave upload
│   ├── recall.js                 ← FTS5 BM25 + semantic memory retrieval
│   ├── external_source_discovery.js ← domain trust registry builder
│   ├── source_selector.js        ← conviction-driven + adversarial source queuing
│   ├── reading_queue.js          ← URL queue (user-shared + conviction + adversarial)
│   ├── prefetch_url.js           ← pre-loads target URL in Chrome before AI cycle
│   ├── moltbook.js               ← Moltbook cross-posting
│   └── cdp.js                    ← Chrome DevTools Protocol helpers
│
├── scraper/                      ← continuous background collection (no LLM)
│   ├── collect.js                ← 13-phase feed ingestion pipeline
│   ├── reply.js                  ← mention processing + reply drafting
│   ├── follows.js                ← data-driven follow decisions (Vertex classification)
│   ├── db.js                     ← SQLite schema + queries (posts, keywords, memory, embeddings)
│   ├── embed.js                  ← Gemini text-embedding-004 via Vertex AI
│   ├── analytics.js              ← scoring algorithms (RAKE, TF-IDF, Jaccard)
│   ├── query.js                  ← topic summary extraction from DB
│   └── start.sh                  ← launches collect, reply, follows loops
│
├── state/                        ← runtime state files
│   ├── index.db                  ← SQLite: posts, keywords, accounts, memory, embeddings
│   ├── ontology.json             ← all belief axes (scores, confidence, evidence_log)
│   ├── trust_graph.json          ← per-account trust scores (1–7) + taxonomy label
│   ├── feed_digest.txt           ← scored clustered digest read by AI agent
│   ├── curiosity_directive.txt   ← active research focus + rotating search URLs
│   ├── cadence.json              ← metacognition state (cycle_interval_sec, directives)
│   ├── reading_queue.jsonl       ← URLs to browse (user-shared + conviction + adversarial)
│   ├── external_sources.json     ← domain trust registry with provenance scores
│   └── ...                       ← see docs/DATA_COLLECTION.md for full list
│
├── journals/                     ← hourly HTML journals (agent-written)
├── daily/                        ← daily belief reports
├── articles/                     ← long-form field reports
├── ponders/                      ← reflective pieces + action plans
├── checkpoints/                  ← 3-day worldview snapshots
│
├── docs/                         ← reference documentation
│   ├── ARCHITECTURE.md           ← full system architecture + DB schema + infra
│   ├── DATA_COLLECTION.md        ← data collection tiers, evidence pipeline, schedules
│   ├── SYSTEM_DIAGRAM.md         ← Mermaid flow diagram + layer summary table
│   ├── PIPELINE.md               ← pipeline status + all state files
│   ├── VERIFICATION_PIPELINE.md  ← claim verification detail
│   └── BUGS.md                   ← known bugs log
│
├── workers/                      ← Cloud Run workers
│   ├── verify/                   ← hunter-verify: claim verification service
│   └── publish/                  ← hunter-publish: verification export + draft storage
│
└── web/                          ← Next.js website → sebastianhunter.fun (Cloud Run)
```

---

## What gets published

Every cycle commits to GitHub; CI/CD deploys `web/**` changes to Cloud Run automatically. State files are synced to GCS every ~1 hour and served to the website.

| Output | Frequency | Description |
|---|---|---|
| `journals/YYYY-MM-DD_HH.html` | Every cycle (~20–30 min) | Observations, tensions, footnoted sources |
| `daily/belief_report_YYYY-MM-DD.md` | Once per day | Full ontology snapshot, axis deltas |
| `articles/YYYY-MM-DD.md` | ~Daily | Long-form opinion piece on a belief axis |
| `ponders/latest.md` | When conviction triggers | Reflective piece + action plans |
| `checkpoints/checkpoint_N.md` | Every 3 days | Complete worldview snapshot + drift analysis |
| `state/ontology.json` | Every cycle | All belief axes with scores, confidence, evidence |

Journals and checkpoints are permanently archived to **Arweave** via Irys (Solana-funded). Evidence source URLs are archived individually so belief provenance is verifiable even if the original tweet is deleted. All scraped posts stream to **BigQuery** (`dataset: hunter, table: posts`) for permanent longitudinal history.

---

## Key documents

| File | Purpose |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full system architecture, DB schema, Cloud infra, LLM budget |
| [docs/DATA_COLLECTION.md](docs/DATA_COLLECTION.md) | Two-tier data collection, evidence validation pipeline, schedules, state files |
| [docs/SYSTEM_DIAGRAM.md](docs/SYSTEM_DIAGRAM.md) | Mermaid flow diagram + layer summary table |
| [docs/PIPELINE.md](docs/PIPELINE.md) | Pipeline status: all automated workflows and state file reference |
| [docs/VERIFICATION_PIPELINE.md](docs/VERIFICATION_PIPELINE.md) | Claim verification scoring and lifecycle |
| [AGENTS.md](AGENTS.md) | Belief ontology rules: axis creation, update formula, manipulation detection |
| [SOUL.md](SOUL.md) | Persona layer: voice, conviction tiers, safety boundaries |

---

## Troubleshooting

**Service status**
```bash
# On VM (via IAP):
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap --command="systemctl status sebastian-runner sebastian-browser"
```

**View logs**
```bash
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap --command="journalctl -u sebastian-runner --no-pager -n 50"
```

**Browser stuck / CDP timeout**
```bash
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap --command="systemctl restart sebastian-browser && sleep 5 && systemctl status sebastian-browser"
```

**Force kill stale CDP port**
```bash
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter --tunnel-through-iap --command="fuser -k 18801/tcp; systemctl start sebastian-browser"
```

**X session expired**
The agent re-authenticates automatically using `X_USERNAME` / `X_PASSWORD` from `.env`.

**Plain SSH returns exit 255**
Always use `--tunnel-through-iap`. The VM is often busy under browse cycle load and plain SSH times out.
