# META Process — Self-Improvement Loop

Sebastian periodically audits its own pipeline failures, identifies concrete gaps, and autonomously proposes and builds fixes.

---

## Flow

```
Reflection trigger (cooldown-gated)
  → LLM reads: recent daily reports + proposal history
  → Identifies: one specific, buildable gap in the pipeline
  → Emits: JSON proposal block → state/process_proposal.json

Builder pipeline picks it up:
  pending → building → testing → merged | failed
  → Result logged to state/proposal_history.json
```

**Key constraint:** only 1 active proposal at a time. A new reflection is skipped if `process_proposal.json` has status `pending | building | testing`.

---

## What it can target

- Prompt framing errors that cause recurring misclassification
- Pipeline, state, or protocol gaps
- Tooling to gather evidence currently not captured

## What it cannot touch

- `SOUL.md`, `IDENTITY.md`, `AGENTS.md` §1–§11
- `orchestrator.js`, `lib/agent.js`, `lib/git.js`, `lib/state.js`
- `.env`, `builder_pipeline.js`, `builder_vertex.js`

---

## Proposal lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Written to `process_proposal.json`, awaiting builder |
| `building` | Builder is generating code changes |
| `testing` | Changes applied, running tests |
| `merged` | All tests passed, auto-merged to main |
| `failed` | Build or test error; logged with reason |

---

## All proposals applied (as of 2026-04-08)

### 1. Claim credibility tracking in evidence evaluation
- **Status:** merged
- **Date:** 2026-03-29
- **Files changed:** `runner/lib/prompts/browse.js`
- **Merge commit:** `50861cfd`
- **Problem:** No mechanism to track or weight the credibility of sources when evaluating evidence.

---

### 2. System for Tracking and Clustering Untracked Themes
- **Status:** merged
- **Date:** 2026-04-04
- **Files changed:** `pipelines/main_pipeline.js`, `lib/evidence_processor.js`, `lib/theme_clusterer.js`, `state/emergent_themes.json`, `prompts/daily_reflection.md`
- **Merge commit:** `b0cf88cf`
- **Problem:** Themes emerging across multiple browse cycles had no persistent tracking or clustering — patterns were lost between cycles.

---

### 3. Build a Belief Stagnation Detector and Axis Health Report
- **Status:** failed
- **Date:** 2026-04-06
- **Files changed:** `pipelines/daily_maintenance.js`, `lib/belief_system.js`, `src/tools/axis_health_reporter.js`, `state/schemas.js`
- **Failure reason:** Import error — `axis_health_reporter.js` required `../../../lib/belief_system` which did not exist at the expected path.
- **Note:** Conceptually valid; the gap it targeted was addressed by proposal #4.

---

### 4. Belief Change Attribution in Daily Reports
- **Status:** merged
- **Date:** 2026-04-07
- **Files changed:** `pipelines/daily_maintenance.js`, `src/tools/belief_reporter.js`, `src/schemas/belief_report.schema.json`
- **Merge commit:** `afb131ff`
- **Problem:** Daily reports showed current axis scores but no delta context — a score could shift significantly with no visibility into what drove it. Example: `axis_power_accountability` moved +0.083 over two days with no audit trail.
- **Solution:** For each axis, compute delta vs. previous day, aggregate contributing evidence metadata, and surface a "Belief Dynamics" section for high-delta axes in the daily report.

---

## Pattern observed

Proposals #3 and #4 both target **belief auditability** — the agent identified the same conceptual gap twice. #3 failed on a broken module path; #4 succeeded. This self-correction pattern (retry with a narrower, more careful scope) is the META process working as intended.

---

## Fetching proposals from GCP

```bash
# All proposals
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter \
  --command="cat /home/raymond_d_baldonado_gmail_com/hunter/state/proposal_history.json"

# Merged only
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter \
  --command="cat /home/raymond_d_baldonado_gmail_com/hunter/state/proposal_history.json | jq '[.proposals[] | select(.status == \"merged\")]'"

# Current active proposal
gcloud compute ssh sebastian --zone=us-central1-a --project=sebastian-hunter \
  --command="cat /home/raymond_d_baldonado_gmail_com/hunter/state/process_proposal.json"
```
