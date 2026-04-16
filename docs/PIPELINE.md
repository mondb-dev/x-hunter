# Pipeline Status & Sequence

Current state of all automated pipelines. Updated as new phases are built.

---

## Browse & Journal (every ~20 min)

```
run.sh BROWSE cycle
  → recall.js          — FTS5 + semantic memory hint for agent
  → comment.js         — discourse counter-arg candidate
  → discourse_scan.js  — scan for exchanges to respond to
  → discourse_digest.js
  → reading_queue.js   — check for queued URLs (user-shared / conviction / adversarial)
  → prefetch_url.js    — curiosity URL or queued URL
  → agent x-hunter     — browse, journal, update ontology
                         (silent hours: sprint work mode — see below)
  → cleanup_tabs.js
  → apply_ontology_delta.js  — 8-gate validation:
                               1. invalid source rejection
                               2. per-session source dedup (seenSourcesThisRun)
                               3. self-echo check
                               4. claim fingerprint dedup (SHA-1, 6h window)
                               5. stance validation (Ollama)
                               6. diversity constraint
                               7. confidence recompute (unique sources × 0.025, cap 0.98)
                               8. confidence decay (−0.002/day on idle axes)
  → detect_drift.js
  → archive.js         — Arweave upload + inline memory embedding
  → watchdog.js
```

**Silent-hours sprint mode (UTC 23-07):**
When the current hour is outside active posting hours AND an active sprint
exists with pending tasks, the browse prompt switches to sprint work mode.
Task priorities flip: sprint research/writing becomes primary, feed observation
becomes secondary. `curiosity.js` also directs search URLs toward sprint
topic keywords during these hours.

**Status:** Running ✓

---

## Quote-Tweet (every 6 browse cycles)

```
run.sh QUOTE cycle
  → agent x-hunter-tweet  — selects tweet, writes quote_draft.txt
  → post_quote.js         — CDP post to X
  → posts_log.json patch  — runner writes tweet_url
```

**Status:** Running ✓

---

## Tweet (every 6 browse cycles, offset from quote)

```
run.sh TWEET cycle
  → agent x-hunter-tweet  — drafts tweet, writes tweet_draft.txt
  → post_tweet.js         — CDP post to X
  → posts_log.json patch  — runner writes tweet_url
```

**Status:** Running ✓

---

## Daily Block (every 72 browse cycles / ~24h)

```
  → daily_snapshot.js          (idempotent full ontology snapshot)
  → generate_daily_report.js
  → capture_detection.js       (source-capture analysis — no LLM)
  → posts_assessment.js        (LLM self-review → posting_directive.txt)
  → write_article.js
  → moltbook.js --post-article
  → post_tweet.js              (article link)
  → generate_checkpoint.js     (self-gates: every 3 days)
  → moltbook.js --post-checkpoint
  → ponder.js                  (self-gates: conviction threshold)
  → post_tweet.js              (ponder declaration, if ponder fired)
  → moltbook.js --post-ponder  (if ponder_post_pending flag)
  → deep_dive.js               (self-gates: 1 day after ponder)
  → decision.js                (self-gates: after deep_dive)
  → backfill_trust.js          (trust recalibration: accounts.trust ± 0.5 based on last 7d)
  → feed_digest.txt trim
```

**Status:** Running ✓

---

## Ponder Pipeline (milestone-driven)

| Phase | Script | Trigger | Output | Status |
|---|---|---|---|---|
| Conviction | `ponder.js` | ≥3 axes at threshold | `ponders/ponder_N.md`, `ponder_tweet.txt`, `ponder_post_pending` | ✓ Live |
| Research | `deep_dive.js` | 1 day after ponder | `state/research_briefs.json` | ⏳ Fires 2026-03-11 |
| Decision | `decision.js` | After deep_dive completes | `state/active_plan.json` | ⏳ Fires 2026-03-11 |
| Build | `builder-mcp` | After decision (future) | GitHub repo + deploy | 🔲 Not built |

**Ponder 1:** 2026-03-10 — "Veritas Lens" + "Weekly Institutional Contradiction Report"
- Tweet: posted ✓
- Website: `/ponders/1` ✓
- Moltbook: https://www.moltbook.com/post/1986491d-f2b9-449a-b469-9451f760ce21 ✓

---

## Pending / Not Yet Built

- **Builder MCP** — receives `active_plan.json`, creates GitHub repo, runs CI, deploys
- **Feedback agent** — tracks post performance (reach, sentiment), writes back to belief weights
- **News curiosity** — NewsAPI / RSS integration for cross-referencing X discourse with reported facts
- **Secretary MCP** — encrypted credential vault (local only)
- **Memory MCP** — wrap SQLite + Arweave as standalone MCP server

---

## State Files Reference

| File | Written by | Read by | Notes |
|---|---|---|---|
| `state/ontology.json` | agent (delta), `apply_ontology_delta.js` | All belief scripts | Primary belief store; evidence entries include summary, claim_id, arweave_tx |
| `state/posts_log.json` | runner (CDP result) | `web/lib/readPosts.ts` | Runner owns writes; agent should not write directly |
| `state/scrape_metrics.jsonl` | `collect.js` (each run) | `watchdog.js` | Per-run throughput: raw/sanitized/stored counts + api_fallback flag |
| `state/source_plan.json` | `source_selector.js` | `source_selector.js` | Most recent conviction pick + last_adversarial_date |
| `state/evidence_url_queue.jsonl` | `apply_ontology_delta.js` | `archive_evidence_urls.js` | Queue of evidence source URLs pending Arweave archiving |
| `state/ponder_state.json` | `ponder.js`, `deep_dive.js`, `decision.js` | Same scripts (self-gate) | Tracks pipeline phase dates |
| `state/research_briefs.json` | `deep_dive.js` | `decision.js` | Intermediate — not committed to git |
| `state/active_plan.json` | `decision.js` | Builder (future) | Winning plan + first sprint |
| `state/ponder_post_pending` | `run.sh` (on ponder) | `run.sh` daily block | Flag: cleared by `moltbook.js --post-ponder` on success |
| `state/builder_task_pending` | `decision.js` (future) | Builder MCP (future) | Flag: pending design |
| `ponders/ponder_N.md` | `ponder.js` | `web/lib/readPonders.ts` | `moltbook:` field patched after Moltbook post |

---
