# Hunter Codebase Audit — Round 2 (2026-02-28)

This round focuses on findings not covered in `audit.md`: ontology-policy compliance, orchestration gaps, clustering correctness, and checkpoint/journal lifecycle fidelity.

## Findings (new, ordered by severity)

1. **Critical: belief update engine does not enforce AGENTS daily drift cap or gradual updates**
   - Spec requires `daily_cap per axis: ±0.05` and gradual drift ([AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:127)).
   - Implementation recomputes full axis score from all evidence each run with no per-day cap ([apply_ontology_delta.js](/Users/mondb/Documents/Projects/hunter/runner/apply_ontology_delta.js:239)).
   - Score can jump to extremes quickly (current state has `axis_epistemic_integrity` at `1.0` with a single evidence entry, violating gradualism intent) ([ontology.json](/Users/mondb/Documents/Projects/hunter/state/ontology.json:8), [ontology.json](/Users/mondb/Documents/Projects/hunter/state/ontology.json:13)).

2. **Critical: axis creation safeguards from AGENTS are not enforced by merge layer**
   - Required controls include max 3 new axes/day and semantic dedup (`similarity > 0.86` -> attach evidence, don’t create new axis) ([AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:88), [AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:96)).
   - `apply_ontology_delta.js` only checks required fields + duplicate ID; no per-day cap, no similarity gate, no duplicate-meaning prevention ([apply_ontology_delta.js](/Users/mondb/Documents/Projects/hunter/runner/apply_ontology_delta.js:262)).

3. **High: required journaling/report/checkpoint cadence is not orchestrated**
   - Spec requires hourly journals, daily report output, and checkpoints every 3 days ([AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:167), [AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:241), [AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:257)).
   - Runner writes journal only on tweet cycles (every 2 hours) and has no daily/checkpoint generation stage ([run.sh](/Users/mondb/Documents/Projects/hunter/runner/run.sh:76), [run.sh](/Users/mondb/Documents/Projects/hunter/runner/run.sh:603)).
   - Repository state reflects this gap: no produced daily reports/checkpoints (only `.gitkeep`) (`daily/`, `checkpoints/`).

4. **High: cluster ordering logic uses a non-existent field**
   - Clusters are sorted by `posts[0].score` in analytics ([analytics.js](/Users/mondb/Documents/Projects/hunter/scraper/analytics.js:273)).
   - Collect pipeline populates post ranking in `total`, not `score` ([collect.js](/Users/mondb/Documents/Projects/hunter/scraper/collect.js:376), [collect.js](/Users/mondb/Documents/Projects/hunter/scraper/collect.js:393)).
   - Impact: cluster sort comparator frequently evaluates `undefined - undefined` (`NaN`), leading to unstable/non-deterministic cluster ordering in digest.

5. **Medium: discourse scanner permanently drops exchanges when assessment fails**
   - On Ollama/parse failure, reply IDs are still marked scanned ([discourse_scan.js](/Users/mondb/Documents/Projects/hunter/runner/discourse_scan.js:167)).
   - This prevents retries after transient local model failures and can silently lose high-value discourse anchors.

6. **Medium: curiosity context reads belief fields that do not exist**
   - `curiosity.js` expects `belief_state.active_axes` / `watch_list` ([curiosity.js](/Users/mondb/Documents/Projects/hunter/runner/curiosity.js:89)).
   - Actual schema stores `created_at` + `axes` array only ([belief_state.json](/Users/mondb/Documents/Projects/hunter/state/belief_state.json:2)).
   - Effect: belief-summary context is consistently blank in trending prompt path (reduced guidance quality).

7. **Medium: checkpoint UX/logic diverges from AGENTS semantics**
   - AGENTS says checkpoints are every 3 days ([AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:257)), while UI copy says weekly ([checkpoints page](/Users/mondb/Documents/Projects/hunter/web/app/checkpoints/page.tsx:14)).
   - `getLatestCheckpoint()` checks `latest.md` existence but ignores its contents and simply returns highest-numbered checkpoint file ([readCheckpoints.ts](/Users/mondb/Documents/Projects/hunter/web/lib/readCheckpoints.ts:51), [readCheckpoints.ts](/Users/mondb/Documents/Projects/hunter/web/lib/readCheckpoints.ts:57)).

8. **Low: ontology records violate own schema completeness (`created_at` empty)**
   - Axis schema requires timestamps ([AGENTS.md](/Users/mondb/Documents/Projects/hunter/AGENTS.md:76)).
   - Current state has empty `created_at` across axes ([ontology.json](/Users/mondb/Documents/Projects/hunter/state/ontology.json:11)).

## Verification notes
- Syntax check still passes: `node --check runner/*.js scraper/*.js`.
- This round did not rerun browser/CDP flows or live posting actions.
