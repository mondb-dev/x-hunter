# Verification Pipeline Updates (2026-04-17)

## Overview

The claim verification system has been upgraded with three changes:

1. **Isolated LLM credentials** — verification uses `BUILDER_CREDENTIALS` (separate service account) to avoid rate-limit contention with the browse/synthesize pipeline
2. **Periodic verification via systemd timer** — `verify_claims.js` runs every 2 hours automatically
3. **On-demand verification via `verify_one.js`** — callable by the agent mid-interaction for priority fact-checking

---

## Architecture

```
                        ┌─────────────────────────┐
                        │   systemd timer (2h)     │
                        │   verify_claims.js       │
                        │   batch: 10 claims/run   │
                        │   web search: 3/run      │
                        └──────────┬──────────────┘
                                   │
                                   ▼
┌───────────────┐    ┌──────────────────────────┐    ┌────────────────────┐
│ intelligence  │───►│   claim_verifications     │───►│ verification_      │
│ .db claims    │    │   (SQLite)                │    │ export.json        │
└───────────────┘    └──────────────────────────┘    └────────┬───────────┘
                                   ▲                          │
┌───────────────┐                  │                          ▼
│ agent call    │    ┌─────────────┴──────────────┐    ┌────────────────┐
│ (reply/QT)    │───►│   verify_one.js            │    │ Veritas Lens   │
│               │◄───│   single claim, web search │    │ /veritas-lens  │
│  JSON stdout  │    └────────────────────────────┘    └────────────────┘
└───────────────┘
```

Both paths use `BUILDER_CREDENTIALS` → `gemini-2.5-flash` with Google Search grounding.

---

## verify_one.js — On-Demand Verification

### CLI

```bash
node runner/intelligence/verify_one.js \
  --claim "The claim text to verify" \
  --source-handle @username \
  --source-url https://x.com/user/status/123 \
  --category diplomatic \
  --axis axis_geopolitical_rhetoric_v1 \
  --source-tier 3 \
  --dry-run
```

Only `--claim` is required. All other flags are optional.

| Flag | Description |
|------|-------------|
| `--claim` | **(required)** The claim text to verify |
| `--source-handle` | X/Twitter handle of the claim source (e.g. `@CNN`) |
| `--source-url` | URL of the source post |
| `--category` | Claim category: `military_action`, `casualties_humanitarian`, `threats_claims`, `nuclear`, `diplomatic`, `proxy_regional`, `internal_politics`, `misc` |
| `--axis` | Related ontology axis ID (e.g. `axis_geopolitical_rhetoric_v1`) |
| `--source-tier` | Source credibility tier 1-5 (1 = most credible) |
| `--dry-run` | Score and search but don't persist to DB |

### From Agent Code

```js
const { execFileSync } = require('child_process');

const result = JSON.parse(
  execFileSync('node', [
    'runner/intelligence/verify_one.js',
    '--claim', claimText,
    '--source-handle', handle,
  ], { cwd: ROOT, timeout: 90_000, encoding: 'utf-8' })
);
```

### Output (JSON on stdout)

```json
{
  "claim_id":      "live_611e273841",
  "status":        "unverified",
  "confidence":    0.375,
  "summary":       "Iran and the US agreed to a two-week ceasefire on April 8, 2026...",
  "verdict_label": "Unverified",
  "lens_url":      "https://sebastianhunter.fun/veritas-lens#live_611e273841",
  "evidence_urls": ["https://reuters.com/..."],
  "framing":       "The claim is framed as a factual statement...",
  "cached":        false
}
```

| Field | Description |
|-------|-------------|
| `claim_id` | Stable hash-based ID (`live_` prefix for on-demand claims) |
| `status` | `supported`, `refuted`, `contested`, or `unverified` |
| `confidence` | 0.0–1.0 composite score |
| `summary` | 2-3 sentence web search findings |
| `verdict_label` | Human-readable status label |
| `lens_url` | Deep link to claim on Veritas Lens page |
| `evidence_urls` | Up to 3 stable source URLs (Vertex grounding redirects filtered out) |
| `framing` | Analysis of whether the claim is framed fairly or misleadingly |
| `cached` | `true` if returning a result verified within the last 6 hours |

### Behavior

- **Always does a web search** — this is priority verification, not batch scoring
- **Persists to `claim_verifications`** — the claim shows up on the Veritas Lens page
- **Re-exports `verification_export.json`** — website updates on next deploy
- **6-hour cache** — if the same claim (by text hash) was verified recently, returns instantly
- **Logs to stderr**, result JSON to stdout — safe for `execFileSync` capture

---

## verify_claims.js — Batch Pipeline (Periodic)

### Configuration

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_CLAIMS_PER_CYCLE` | 10 | Claims scored per run |
| `WEB_SEARCH_PER_CYCLE` | 3 | Claims web-searched per run |
| `STALE_HOURS` | 48 | Unresolved claims older than this get priority |

### Systemd Timer

Installed at `~/.config/systemd/user/verify-claims.timer`. Runs every 2 hours at :17 past the odd hour with up to 2 minutes random jitter.

```bash
# Check status
systemctl --user status verify-claims.timer
systemctl --user list-timers verify-claims.timer

# View logs
tail -f runner/verify_claims.log

# Manual run
systemctl --user start verify-claims.service

# Disable
systemctl --user disable --now verify-claims.timer
```

### Claim Sources

1. **`claim_tracker.json`** — manually curated claims (tracker source, higher priority)
2. **`intelligence.db` `claims` table** — auto-extracted from browse cycles

### Expiry Rules

| Category | TTL |
|----------|-----|
| `military_action` | 72 hours |
| `casualties_humanitarian` | 72 hours |
| `threats_claims` | 72 hours |
| `nuclear` | 7 days |
| `diplomatic` | 7 days |
| `proxy_regional` | 7 days |
| `internal_politics` | 30 days |
| `misc` | 30 days |

---

## Scoring Model

Both `verify_one.js` and `verify_claims.js` use the same scorer (`claim_scorer.js`):

| Component | Weight | Scoring |
|-----------|--------|---------|
| Source tier | 0.30 | Tier 1 = 1.0, Tier 5 = 0.2, unknown = 0.5 |
| NewsGuard | 0.15 | ng_score / 100, unknown = 0.5 |
| Corroboration | 0.20 | Saturates at 3 sources |
| Evidence quality | 0.15 | 0.0 (no URL), 0.5 (unknown domain), 1.0 (Tier 1-2 domain) |
| Cross-source | 0.10 | 1.0 (no contradictions) to 0.0 (all contradict) |
| Web search | 0.10 | confirmed=1.0, partial=0.8, inconclusive=0.5, refuted=-1.0 |

**Status thresholds:**
- `supported`: confidence >= 0.75 AND web search >= 0.8
- `refuted`: web search returns "refuted" OR (confidence <= 0.25 AND has web evidence)
- `contested`: has both corroborating and contradicting sources
- `unverified`: everything else

---

## LLM Credentials

Both scripts use `BUILDER_CREDENTIALS` (separate GCP service account) calling `gemini-2.5-flash` with Google Search grounding. This keeps verification traffic isolated from the main browse/synthesize pipeline which uses `GOOGLE_APPLICATION_CREDENTIALS`.
