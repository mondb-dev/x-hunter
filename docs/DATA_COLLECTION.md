# Data Collection

The system has two parallel collection tiers: a **continuous scraper** (dumb, always-on) and an **AI-driven browse cycle** (intelligent, curiosity-directed).

---

## Tier 1: Continuous Feed Scraper (`scraper/`)

Three independent loops launched by `scraper/start.sh`:

### `collect.js` — every 10 minutes

The core ingestion engine. 13-phase pipeline per run:

1. **Feed fetch**: CDP-connects to Chrome on port 18801, navigates `x.com/home`, scrolls 3×, extracts post DOM. Falls back to X API v2 `getHomeTimeline` if browser is unavailable.
2. **Sanitize** (`analytics.sanitizePost`): drops ads (`\nPromoted`), posts <20 chars, emoji-spam, non-English, repetitive content. Deduplicates against `seen_ids.json` (rolling 10k window).
3. **RAKE scoring**: keyword extraction per post + composite `total` score from: HN-style time-decay gravity + trust lookup (`trust_graph.json`) + ontology axis word alignment.
4. **Jaccard dedup**: removes near-duplicate stories at 0.65 similarity threshold.
5. **TF-IDF novelty**: computes IDF from last 4h corpus, re-scores posts — `total += novelty × 0.4`, re-sorts.
5c. **Gemini enrichment** (top 20 posts only): calls Gemini Flash per post with a structured extraction prompt. Attaches `post.gemini_meta` — `{ entities, claim, stance, credibility_signals, axis_relevance }`. Failures silently skipped; RAKE retained as the initial fast filter.
6. **Dynamic limits**: reads `state/cadence.json` → `signal_density` + `belief_velocity` → determines `topPosts` (15–50) and `replyFetchCount` (5–15).
7. **Media capture**: screenshots up to 10 posts with images/video via `el.screenshot()`.
7b. **Inline embedding**: embeds up to 20 top posts (by score) immediately after SQLite insert via `embed()` → `db.storeEmbedding("post", ...)`. Eliminates post-embedding gap.
8. **Reply fetch**: navigates to permalink for top posts, fetches up to 5 replies each (CDP or API `searchRecent` fallback).
9. **Gemini Vision** (`describeMedia`): batch-sends captured screenshots for text description.
10. **SQLite write**: inserts posts, keywords, replies into `state/index.db`; upserts per-account rolling stats. Each post is also streamed to BigQuery (`dataset: hunter, table: posts`, project `sebastian-hunter`) for permanent history — fire-and-forget, failures do not block pipeline.
11. **Cluster + burst detection**: `clusterPosts()` (Jaccard 0.25), `detectBursts()` (4h vs 4–8h keyword frequency), `tagClusterBursts()`.
12. **Output**: clustered digest → `feed_digest.txt`; raw JSONL → `feed_buffer.jsonl`; mentions → `reply_queue.jsonl`; `seen_ids.json` updated.
13. **Metrics**: appends to `state/scrape_metrics.jsonl` — `{ ts, raw, after_sanitize, after_dedup, after_novelty, stored, api_fallback, reply_count }`. If last 3 runs all have `stored < 5`, sets `health_state.json` `scrape_degraded: true`.

**State files written:** `state/index.db`, `state/feed_buffer.jsonl`, `state/feed_digest.txt`, `state/seen_ids.json`, `state/reply_queue.jsonl`, `state/scrape_metrics.jsonl`

### `follows.js` — every 3 hours

1. Queries `accounts` table for candidates with `post_count >= 2`, `avg_score >= 5.0`.
2. Scores each: `velocity×0.35 + avg_score×0.30 + topic_affinity×0.25 + recency×0.10`. Topic affinity = fraction of account's top keywords matching ontology axis words.
3. Populates `follow_queue.jsonl` with up to 5 new candidates.
4. Processes up to 3 pending follows per run via CDP (1-minute gap between follows).
5. Calls Vertex AI to classify each follow — returns JSON with three fields:
   - `cluster`: one label from a **fixed 30-label taxonomy** (geopolitics, us_politics, middle_east, asia_pacific, latin_america, europe, economics, markets_finance, tech_ai, science, disinformation, accountability_journalism, legal_courts, military, climate_energy, health, crypto_web3, entertainment, sports, animal_content, humor_memes, religion, human_rights, sovereignty, elections, media_criticism, conspiracy, academic_research, government_official, breaking_news)
   - `trust_score`: integer 1–7 (1=unreliable/entertainment, 4=neutral news, 7=primary source/expert)
   - `follow_reason`: one-sentence relevance explanation
6. Writes cluster + trust_score + follow_reason to `trust_graph.json`; mirrors trust_score to SQLite `accounts.trust`; marks `followed=1`.

Daily cap: 10 follows/day.

### `reply.js` — every 30 minutes

Processes the `reply_queue.jsonl` mention backlog.

---

## Tier 2: AI Browse Cycle (`runner/`)

The Gemini agent (`gemini_agent.js`) runs every ~30 min (auto-adjusted 15–60 min by the metacognition engine). Before each cycle, `runner/lib/pre_browse.js` executes a 14-step preparation pipeline.

### Pre-Browse Pipeline (`runner/lib/pre_browse.js`)

| Step | Script | Fires |
|---|---|---|
| 1 | `fts_maintain.js` — FTS5 integrity check + rebuild | every cycle |
| 2 | `scraper/query.js --hours 4` — generates `topic_summary.txt` | every cycle |
| 3 | `recall.js` — FTS5 + semantic memory search using top-3 topic keywords | every cycle |
| 4 | `curiosity.js` — refreshes research directive | every 12th cycle |
| 5 | `cluster_axes.js` — groups belief axes | co-fires with curiosity |
| 6 | `comment_candidates.js` — finds posts suitable for commenting | every cycle |
| 7 | `discourse_scan.js` — scans reply interactions for challenges → `discourse_anchors.jsonl` | every cycle |
| 8 | `discourse_digest.js` — formats `discourse_digest.txt` | every cycle |
| 9 | `external_source_discovery.js` — full source registry refresh | every cycle |
| 10 | `external_source_profile.js` — live profiling of top sources | every cycle |
| 11 | `source_selector.js` — conviction-driven + adversarial source queueing | every 3rd cycle |
| 12 | `reading_queue.js` — scans interactions for user-shared URLs | every cycle |
| 13 | `deep_dive_detector.js` — detects when a deep-dive is warranted | every 6th cycle |
| 14 | `prefetch_url.js` — pre-loads target URL in Chrome | every cycle |

---

### Evidence Write Path (`runner/apply_ontology_delta.js`)

Post-browse, the runner merges the agent-written `state/ontology_delta.json` into `state/ontology.json`. Validation gates applied in order:

1. **Invalid source rejection**: sources that are `browse_notes`, `web_search`, `internal`, empty string, or any non-`http(s)://` URL are dropped — not retrievable or verifiable.
2. **Per-session source dedup** (`seenSourcesThisRun` Set): each URL may update at most one axis per browse session. Prevents pseudo-replication from inflating confidence.
3. **Self-echo check**: entries sourced from Sebastian's own posts/tweets are rejected.
4. **Claim fingerprinting** (`computeClaimFingerprint`): SHA-1 on normalised/stopword-stripped tokens → 12-char hex `claim_id`. Within a 6h window, duplicate `claim_id` entries are skipped regardless of source. Prevents a single news event reported by multiple outlets from spiking axis confidence.
5. **Stance validation**: Ollama confirms claimed `pole_alignment` matches entry content (min 0.50 confidence).
6. **Diversity constraint**: if one pole exceeds 70% of today's entries for an axis, weight is halved; above 90%, the entry is skipped entirely.
7. **Confidence recompute (on updated axes only)**:
   - `score = Σ(trust_weight × ±1) / Σ(trust_weight)` — trust-weighted mean over full evidence_log
   - `confidence = min(0.98, uniqueSources × 0.025)` — unique source count drives ceiling, not total entry count — pseudo-replicated sources cannot inflate it
   - Daily drift cap: score cannot move more than ±0.05/day
8. **Confidence decay (on non-updated axes)**: once per calendar day, axes with no new evidence lose `0.002` confidence (tracked via `axis.last_decayed_at`). Prevents permanent saturation. Minimum 0.

**Evidence entry format** (`state/ontology_delta.json`):
```json
{
  "axis_id": "axis_power_accountability",
  "source": "https://...",
  "content": "one paraphrase sentence",
  "summary": "1-2 sentences: what was observed and why it moves the axis",
  "timestamp": "2026-04-16T03:00:00Z",
  "pole_alignment": "left" | "right"
}
```
The `summary` field is required — entries without it cannot be retrieved by semantic search. 82.5% of existing entries have summaries as of 2026-04-16; backfill ongoing via `runner/backfill_evidence_summaries.js`.

---

## Curiosity Directive (`runner/curiosity.js`)

Fires every 12th BROWSE cycle (~4 hours). Determines *what to research next* via a priority ladder:

1. **discourse** — someone challenged Sebastian's thinking → builds 3 search angles from their topic
2. **contradiction** — two established belief axes have opposing score signs + overlapping label keywords → investigates the tension
3. **uncertainty_axis** — picks axis with highest `gain = (1 - confidence) × polarization × recency_decay × staleness_boost` below confidence ceiling (0.82)
4. **trending** — Ollama (`qwen2.5:7b`) selects from top 5 keywords of last 4h; falls back to `top[0]`

Outputs 3 rotating search angle URLs to `state/curiosity_directive.txt`:
- Angle 1: main search terms (`x.com/search?q=...&f=live`)
- Angle 2: left-pole / counter-perspective or "debate" suffix
- Angle 3: right-pole / affirmative perspective; replaced by an adversarial counter-angle every 12 curiosity cycles (injected by `source_selector.js`)

Also evaluates the previous directive's hit rate (did the targeted axis gain new evidence?) and logs result to `state/curiosity_log.jsonl`.

---

## URL Prefetching (`runner/prefetch_url.js`)

Pre-loads the target URL in Chrome before each AI cycle. Priority:

1. `state/reading_url.txt` — top item from reading queue (`targetType = "deep_dive"`)
2. `state/curiosity_directive.txt` — rotates through `SEARCH_URL_N` lines by `cycle % angles.length`
3. Default: `https://x.com/home`

Fallback on X login redirect:
- deep_dive → scholarly URL or Google Scholar search
- curiosity → Reddit search (`reddit.com/search?q=...&sort=hot&t=week`)
- home → `newsguardtech.com/reports/`

Detects X search degradation (suspended account) and falls back to home feed with `x_search_degraded` label. Writes label + final URL to `state/prefetch_source.txt`.

---

## External Source Discovery (`runner/external_source_discovery.js`)

Runs every cycle. Collects all external URLs seen across the entire pipeline into domain buckets:

**Sources scanned:**
- `ontology.json` evidence_log[].source
- `claim_tracker.json` claims[].cited_url
- `posts_log.json` posts[].source_url
- `reading_queue.jsonl`
- `feed_buffer.jsonl` external_urls + reply external_urls
- All files in `journals/` and `articles/`
- `state/prefetch_source.txt`

**Domain classification (regex-based):** official (.gov/.mil), court_archive, academic (arXiv/Nature/SSRN/PubMed), news (Reuters/AP/BBC/NYT/Guardian/ProPublica/AJ), reference (Wikipedia/archive.org), forum (Reddit/HN), newsletter_blog (Substack/Medium).

**Scoring per domain:**
- `provenance`: 0.45–0.95 based on domain kind
- `breadth`: distinct URLs × axes × origin types
- `corroboration`: distinct referring accounts × origin type count
- `track_record`: supported/refuted claim ratio

Writes sorted results to `state/external_sources.json`, preserving any existing `profile` ratings.

---

## Conviction-Driven Source Selection (`runner/source_selector.js`)

Runs every 3rd BROWSE cycle. Two modes:

**Conviction mode** — picks the strongest active belief axis (confidence ≥ 0.70, evidence ≥ 4, |score| ≥ 0.08), weighted by `axisStrength`, penalized for recently-selected axes. Maps axis + vocation to a category, then ranks candidates from `external_sources.json`:

| Category | Outlets |
|---|---|
| `disinformation_accountability` | ProPublica, CourtListener, Reuters, AP, BBC |
| `accountability_investigation` | ProPublica, CourtListener, Reuters, AP, BBC |
| `world_affairs` | Reuters, AP, BBC, CourtListener |
| `research` | arXiv, PubMed, Nature, Reuters |
| `public_interest` | Reuters, AP, BBC, ProPublica |

Best unseen URL appended to `reading_queue.jsonl` with `from_user: "conviction_source"`.

**Adversarial mode** (`selectAdversarialSource()`) — fires once per day (tracked via `last_adversarial_date` in `source_plan.json`). Picks the highest-confidence axis with `confidence ≥ 0.70`, `|score| > 0.3`, `evidence ≥ 4`. Builds a counter-pole search query, selects from Reuters/AP/BBC/Guardian/Scholar. Appended to `reading_queue.jsonl` with `from_user: "adversarial_selector"`. Ensures Sebastian regularly encounters credible arguments against his strongest positions.

Writes `state/source_plan.json`.

---

## Reading Queue (`runner/reading_queue.js`)

Three input pathways for URLs to browse:
- **User-shared**: scans `interactions.json` replies for `x.com`/`twitter.com` URLs + `@mention` profile URLs → appended to `reading_queue.jsonl`
- **Conviction-driven**: `source_selector.js` conviction mode appends trusted outlet URLs
- **Adversarial**: `source_selector.js` adversarial mode appends one counter-source per day

`emitTopItem()` picks the oldest unconsumed, non-stale (within 24 cycles) item → writes to `state/reading_url.txt` as `URL: ...\nFROM: ...\nCONTEXT: ...`. Adds `in_progress_cycle` marker.

---

## SQLite Schema (`scraper/db.js`)

Database: `state/index.db`

| Table | Purpose |
|---|---|
| `posts` | All scraped posts + metrics (id, ts, username, text, likes, rts, velocity, trust, score, novelty, keywords, external_urls, media_type, media_description, parent_id) |
| `posts_fts` | FTS5 virtual table over (username, text, keywords), synced by triggers |
| `keywords` | Inverted index: keyword → post_ids with scores |
| `accounts` | Per-account aggregates: post_count, avg_score, avg_velocity, top_keywords, follow_score, followed, **trust** (integer 1–7; populated by `follows.js` at follow time; backfilled via `backfill_trust.js`; recalibrated weekly by `runner/lib/daily.js`) |
| `memory` | Indexed journal/checkpoint/article entries with Arweave tx_id |
| `memory_fts` | FTS5 over memory (type, title, text_content, keywords) |
| `embeddings` | 768-dim Gemini `text-embedding-004` vectors keyed by (entity_type, entity_id); used for semantic recall. Memory: 100% coverage; posts: embedded inline at collect time. |

Pruning: posts + keywords older than 7 days deleted on `db.prune()`. All posts are also streamed to BigQuery (`dataset: hunter, table: posts`) for permanent longitudinal history.

---

## Arweave Archiving (`runner/archive.js`)

Post-cycle memory archiver. Scans `journals/`, `checkpoints/`, `daily/`, `articles/`, `ponders/` for files not yet in the `memory` table. For each:

1. Extracts text (strips HTML for `.html` files)
2. RAKE keyword extraction
3. Inserts to `memory` table (idempotent on `file_path`)
4. Immediately embeds `text_content` via `embed()` and stores vector in `embeddings` table
5. Uploads to Arweave via Irys (Solana-funded)
6. On success: appends to `state/arweave_log.json`, calls `db.updateMemoryTxId()`

Gateway: `gateway.irys.xyz/{tx_id}` — do **not** use `arweave.net` (returns 404s).

Evidence source URLs are also archived: each new `evidence_log` entry appends `{ url, axis_id, ts }` to `state/evidence_url_queue.jsonl`. `runner/archive_evidence_urls.js` drains this queue on demand — uploads each URL as a JSON stub to Arweave and writes the returned `arweave_tx` back onto the evidence entry. Makes belief provenance permanently verifiable even if the source tweet is later deleted.

---

## Data Flow

```
X feed (CDP/API)
  → collect.js → sanitize + RAKE + TF-IDF + Gemini enrichment + cluster
    → state/index.db                 (posts, keywords, accounts)
    → BigQuery: dataset hunter        (permanent history, never pruned)
    → state/feed_buffer.jsonl         (raw JSONL)
    → state/feed_digest.txt           (scored digest for AI context)
    → state/reply_queue.jsonl         (mentions)
    → state/scrape_metrics.jsonl      (per-run throughput metrics)
    → embeddings table (top 20 posts, inline)

AI browse cycle
  → pre_browse.js (14 steps) → prefetch_url.js (Chrome pre-load)
  → gemini_agent.js reads feed_digest.txt + curiosity_directive.txt + topic_summary.txt
  → writes browse_notes.md + ontology_delta.json
  → apply_ontology_delta.js: 8-gate validation (dedup + fingerprint + confidence + decay)
  → journals/YYYY-MM-DD_HH.html

archive.js (post-cycle)
  → memory table + inline embedding → state/index.db
  → Arweave via Irys → state/arweave_log.json
  → evidence_url_queue.jsonl → archive_evidence_urls.js → arweave_tx on evidence entries

Daily (once/24h via runner/lib/daily.js)
  → daily_snapshot + article + checkpoint + ponder + sprint
  → trust recalibration (accounts.trust ± 0.5, last 7d performance)
  → git commit + push → Vercel deploy + GCS sync
```

---

## Schedule

| Process | Interval | Entry point |
|---|---|---|
| Feed scrape (`collect.js`) | 10 min | `scraper/start.sh` |
| Reply processor (`reply.js`) | 30 min | `scraper/start.sh` |
| Follow queue (`follows.js`) | 3 hours | `scraper/start.sh` |
| BROWSE cycle (AI) | ~30 min (auto 15–60 min) | `orchestrator.js` |
| QUOTE cycle | Every 3rd BROWSE | `orchestrator.js` |
| TWEET cycle | Every 6th BROWSE | `orchestrator.js` |
| Curiosity refresh | Every 12th BROWSE (~4h) | `pre_browse.js` |
| Source selector (conviction + adversarial) | Every 3rd BROWSE | `pre_browse.js` |
| Deep dive detector | Every 6th BROWSE | `pre_browse.js` |
| Engagement scrape (own posts) | Every 6th BROWSE | `post_browse.js` |
| Daily maintenance | Once per 24h | `runner/lib/daily.js` |

---

## Key State Files

| File | Role |
|---|---|
| `state/index.db` | SQLite: posts, keywords, accounts, memory, embeddings |
| `state/feed_digest.txt` | Clustered scored digest read by AI agent (trimmed to 72h/max lines) |
| `state/feed_buffer.jsonl` | Raw JSONL of every scraped post |
| `state/seen_ids.json` | Rolling 10k dedup set |
| `state/reply_queue.jsonl` | Pending mention replies |
| `state/scrape_metrics.jsonl` | Per-run scrape throughput; monitored by watchdog for degradation |
| `state/reading_queue.jsonl` | URLs to browse (user-shared + conviction + adversarial) |
| `state/reading_url.txt` | Current reading target emitted to agent |
| `state/curiosity_directive.txt` | Active research focus + search URLs |
| `state/curiosity_log.jsonl` | History of curiosity decisions + hit rate |
| `state/external_sources.json` | Domain trust registry with scores |
| `state/source_plan.json` | Most recent source_selector selection |
| `state/prefetch_source.txt` | Current browser source label + URL |
| `state/discourse_anchors.jsonl` | Unprocessed + processed discourse challenges |
| `state/cadence.json` | Agent-written self-assessment + directives (focus_note, cycle_interval_sec, browse_depth, post_eagerness, curiosity_intensity); `cadence.js` runner merges this with computed environmental signals and writes back |
| `state/trust_graph.json` | Per-account trust scores (integer 1–7), follow reason, cluster (30-label taxonomy) |
| `state/ontology.json` | Belief axes with evidence_log (summary + claim_id + arweave_tx per entry) |
| `state/arweave_log.json` | Arweave upload history |
| `state/evidence_url_queue.jsonl` | Pending evidence source URLs awaiting Arweave archiving |
| `state/follow_queue.jsonl` | Follow candidate queue with status |

---

## Notes

- `builder_pipeline.js`, `builder_call.js`, `capture_detection.js` — all empty stubs, unimplemented.
- `cadence.js` is the **metacognition engine** (filename is misleading). Reads agent-written directives from `state/cadence.json`, computes environmental signals (`signal_density`, `belief_velocity`, `post_pressure`, `staleness`), merges them (agent overrides take priority, guardrails enforced), and writes back to `state/cadence.json`. Auto-adjusts cycle timing (900–3600s).
- Semantic embeddings: memory 100% covered; posts embedded inline at collect time. Model: Gemini `text-embedding-004` (768-dim) via Vertex AI. No manual backfill needed going forward.
- Evidence summaries: 82.5% populated as of 2026-04-16. Remaining entries being filled via `runner/backfill_evidence_summaries.js`. Re-run `backfill_embeddings.js --memory` after completion to embed the new summaries.
- Trust scores: populated by `follows.js` at follow time + `backfill_trust.js` (already run; avg 3.33, range 1–7, 3,866 accounts). Weekly recalibration fires via `runner/lib/daily.js`.
- BigQuery: `@google-cloud/bigquery` installed in `scraper/`. Dataset `hunter`, table `posts`, project `sebastian-hunter` (US region). Posts streamed at insert time; failures suppressed.
