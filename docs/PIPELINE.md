# Pipeline Status & Sequence

Current state of all automated pipelines. Constants + file:line ground truth:
[INVENTORY.md](INVENTORY.md).

---

## Browse & Journal (every 15–60 min, cadence-controlled)

```
orchestrator BROWSE cycle
  → pre_browse.js (17 steps) — fts_maintain, topic summary, recall (FTS5 +
    semantic), curiosity, search_curiosity, cluster_axes, rss_collect,
    comment_candidates, discourse_scan, discourse_digest, external source
    discovery + profiling, source_selector, reading_queue, deep_dive_detector,
    prefetch, source-label classification
  → agent (qwen2.5-agent via gemini_agent.js) — browse assigned lead, journal,
    write ontology_delta.json (silent hours: sprint work mode — see below)
  → social pipeline — LinkedIn + X engagement tasks (HelmStack)
  → cleanup_tabs.js
  → apply_ontology_delta.js — evidence gates:
       1. invalid source rejection
       2. per-session source dedup (seenSourcesThisRun)
       3. self-echo check
       4. claim fingerprint dedup (SHA-1, 6h window)
       5. stance validation (local LLM, min conf 0.50)
       6. diversity constraint (dominant pole >70% → half weight; >90% → skip)
       7. score/confidence recompute (runner/lib/belief_calibration.js —
          recency-weighted mean, half-life 100; conf = 0.95·(1−e^(−ws/35)))
       8. drift cap ±0.05/day · confidence decay −0.002/day on idle axes
  → detect_drift.js
  → archive.js — Arweave upload + inline memory embedding
  → watchdog.js
```

**Silent-hours sprint mode (UTC 23-07):** browse prompt switches to sprint
work; curiosity directs search URLs toward sprint topic keywords.

**Status:** Running ✓

---

## Quote (every 3rd cycle) · Tweet (every 6th cycle)

```
orchestrator QUOTE/TWEET cycle          (posting window 07–23 local)
  → compose (Claude via runner/lib/compose.js) — draft grounded in notes/axes/memory
  → outbound gates (voice + fact-check)
  → post via HelmStack X engine (post_x_helmstack.js; OUTBOX_X=1 routes
    through the outbox queue)
  → posts_log.json patch — tweet_url
  → amplify_measure tagging (for the learn-loop)
```

**Status:** Running ✓

---

## Outbound queue & amplification

- **Outbox** (`runner/lib/outbox.js`, `state/outbox.db`) — LinkedIn fully migrated;
  X opt-in (`OUTBOX_X`). Status-tracked, content-dedup 7 days, LIFO claim.
- **X amplify** (`x_amplify.js`) — bandit-picked repost, 1/run; measured by
  `amplify_measure.js` (>24h old, max 8/run) into `lib/amplify_performance`.
- **LinkedIn amplify** (`linkedin_amplify.js`) — reshare parallel of the above.
- **LinkedIn posting** — plan-first (`runner/lib/linkedin_plan.js`); shape assigned by
  the A/B controller (`lib/linkedin_performance.pickShape`); images via voyager
  media pipeline; source-image auto-trigger (`runner/lib/lead_source_image.js`).
- **Facebook** — observation live (`fb_collect.js`); share loop pending
  (posting-roadmap.md).

**Status:** Running ✓ (FB share pending)

---

## Research & positions (daily block + reactive)

- **Deep research** — X mentions (research intent), Telegram `/dr`, and one
  open plan question per day (`plan_research.js`). See DEEP_RESEARCH.md.
- **Stance scan** (`stance_scan.js`, daily) — resolve up to 2 open stances,
  form 0-2 new ones; outcomes feed the ontology. See STANCES.md.
- **Prediction resolution** (`prediction_resolution.js`, 1/day) — resolves
  expired predictions; calibration feeds back into generation. See
  PREDICTIONS.md.

**Status:** Running ✓

---

## Daily Block (~24h)

```
  → daily_snapshot.js          (idempotent full ontology snapshot)
  → generate_daily_report.js
  → capture_detection.js       (source-capture analysis — no LLM)
  → posts_assessment.js        (LLM self-review → posting_directive.txt)
  → write_article.js           (plan-first axis selection; X Articles delivery)
  → moltbook.js --post-article
  → generate_checkpoint.js     (self-gates: every 3 days)
  → ponder.js                  (self-gates: conviction threshold)
  → deep_dive.js / decision.js (self-gate chain after ponder)
  → stance_scan.js / plan_research.js / prediction_resolution.js (detached)
  → backfill_trust.js          (trust recalibration ± 0.5 based on last 7d)
  → operating-cost rollup      (runner/lib/operating_cost.compute → reflection)
  → feed_digest.txt trim
```

**Status:** Running ✓

---

## State Files Reference

| File | Written by | Read by | Notes |
|---|---|---|---|
| `state/ontology.json` | agent (delta), `apply_ontology_delta.js` | all belief scripts | evidence entries include summary, claim_id, arweave_tx |
| `state/outbox.db` | producers via `runner/lib/outbox.js` | channel drainers | append-only queue, statuses pending→posted/rejected/failed/stale |
| `state/posts_log.json` | posting adapters | `web/lib/readPosts.ts` | runner owns writes |
| `state/prediction_log.jsonl` | predictive_prompt, prediction_resolution | web /predictions | + `prediction_export.json` |
| `state/cost_ledger.jsonl` | `runner/lib/cost_meter.js` | `runner/lib/operating_cost.js` | one line per LLM call |
| `state/tool_gaps.json` | deep_research RESOLVE | capability review | unresolvable info needs |
| `state/plan_research_state.json` | plan_research.js | itself | reset when active plan changes |
| `state/scrape_metrics.jsonl` | `collect.js` | `watchdog.js` | per-run throughput |
| `state/source_plan.json` | `source_selector.js` | itself | conviction pick + last_adversarial_date |
| `state/evidence_url_queue.jsonl` | `apply_ontology_delta.js` | `archive_evidence_urls.js` | Arweave archiving queue |
| `state/active_plan.json` | `decision.js` | plan_research, sprint | winning plan + sprint |
| `ponders/ponder_N.md` | `ponder.js` | `web/lib/readPonders.ts` | `moltbook:` field patched after post |
