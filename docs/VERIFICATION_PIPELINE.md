# Verification Pipeline (updated 2026-04-19)

## Overview

The claim verification system provides three capabilities:

1. **Isolated LLM credentials** — verification uses `BUILDER_CREDENTIALS` (separate service account) to avoid rate-limit contention with the browse/synthesize pipeline
2. **Periodic verification via systemd timer** — `verify_claims.js` runs every 2 hours automatically
3. **On-demand verification via `verify_one.js`** — callable by the agent mid-interaction for priority fact-checking
4. **Grounded reply drafting** — both reply pipelines (`proactive_reply.js` and `scraper/reply.js`) use Vertex AI with Google Search grounding (`tools: [{ google_search: {} }]`) when composing replies, enabling independent fact-checking at draft time and automatic source citation

---

## Architecture

```
                                         LAYER 1: CLAIM VERIFICATION
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

                                         LAYER 2: GROUNDED REPLY DRAFTING
                        ┌─────────────────────────────────┐
                        │  Vertex AI + Google Search tool  │
                        │  (tools: [{ google_search: {} }])│
                        └──────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                                         ▼
   ┌──────────────────┐                      ┌──────────────────┐
   │ proactive_reply   │                      │ scraper/reply.js │
   │ draftReply()      │                      │ geminiClassify() │
   │ callGemini +      │                      │ fetch + google   │
   │ google_search     │                      │ _search          │
   └──────┬───────────┘                      └──────┬───────────┘
          │                                         │
          ▼                                         ▼
   ┌──────────────────┐                      ┌──────────────────┐
   │ Grounding URLs   │                      │ Grounding URLs   │
   │ extracted from   │                      │ extracted from   │
   │ Vertex metadata  │                      │ Vertex metadata  │
   │ → appended to    │                      │ → appended to    │
   │   reply text     │                      │   reply text     │
   └──────────────────┘                      └──────────────────┘
```

Layer 1 runs **before** the reply draft (pre-verification via `verify_one.js`).
Layer 2 runs **during** draft composition — the drafting LLM itself can search the web in real time.
Both use `gemini-2.5-flash` with Google Search grounding.

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

| Pipeline | Credentials | Model | Google Search |
|----------|-------------|-------|---------------|
| `verify_one.js` (pre-verification) | `BUILDER_CREDENTIALS` | `gemini-2.5-flash` | Yes (`google_search: {}`) |
| `verify_claims.js` (batch) | `BUILDER_CREDENTIALS` | `gemini-2.5-flash` | Yes (`google_search: {}`) |
| `proactive_reply.js` (draft) | `GOOGLE_APPLICATION_CREDENTIALS` | `gemini-2.5-flash` | Yes (`google_search: {}`) |
| `scraper/reply.js` (draft) | `GOOGLE_APPLICATION_CREDENTIALS` | `gemini-2.5-flash` | Yes (`google_search: {}`) |

Pre-verification uses `BUILDER_CREDENTIALS` (separate GCP service account) to keep verification traffic isolated from the main browse/synthesize pipeline. Reply drafting uses the main `GOOGLE_APPLICATION_CREDENTIALS` via `callGemini()` (from `runner/lib/sebastian_respond.js` for proactive replies, direct `fetch` for inbound replies).

---

## Code Organization

### Pre-verification (Layer 1)

Shared logic is extracted into `runner/intelligence/lib/` to avoid duplication:

```
runner/intelligence/
  verify_claims.js        — batch orchestrator (systemd timer)
  verify_one.js           — on-demand single-claim verification
  claim_scorer.js         — pure scoring (weights, thresholds, component scorers)
  verification_db.js      — SQLite CRUD for claim_verifications + audit log
  db.js                   — intelligence.db connection singleton
  lib/
    web_search.js          — Gemini + Google Search grounding via BUILDER_CREDENTIALS
    verification_export.js — export claim_verifications to JSON for the web frontend
    source_data.js         — load source credibility from intelligence.db or source_registry.json

runner/lib/
  verify_claim.js          — sync wrapper: execFileSync → verify_one.js → parsed JSON result
```

### Grounded reply drafting (Layer 2)

```
runner/lib/
  sebastian_respond.js     — callGemini() with tools support (google_search, etc.)
                             Used by proactive_reply.js draftReply()

runner/
  proactive_reply.js       — draftReply() calls callGemini({ tools: [{ google_search: {} }] })
                             Returns { text, sourceUrls } — sourceUrls from groundingMetadata

scraper/
  reply.js                 — geminiClassify() calls Vertex fetch({ tools: [{ google_search: {} }] })
                             Returns { verdict, reply, reason, sourceUrls } — sourceUrls from groundingMetadata
```

---

## Live Integration (2026-04-17)

Verification is wired into all three engagement surfaces via `runner/lib/verify_claim.js`, a shared wrapper that calls `verify_one.js` and parses the JSON result.

### Wrapper: `runner/lib/verify_claim.js`

```js
const { verifyClaim } = require('./runner/lib/verify_claim');

const result = verifyClaim({
  claim: 'Iran closed the Strait of Hormuz',
  handle: '@IRGC_NEWS',
  url: 'https://x.com/IRGC_NEWS/status/123',
  category: 'military_action',
  axis: 'axis_geopolitical_rhetoric_v1',
  tier: 3,
  dryRun: false,
});
// result = { claim_id, status, confidence, summary, verdict_label, lens_url, evidence_urls, framing, cached }
// or null on failure
```

Handles stdout noise from web_search debug output by scanning lines bottom-up for the first JSON object. 90s timeout, errors return `null` (never throws).

### Integration Points

```
                       ┌──────────────────────────┐
                       │  verify_claim.js wrapper  │  ← Layer 1 (pre-verification)
                       │  (execFileSync → JSON)    │
                       └───────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
   ┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
   │ Claims Thread    │  │ Proactive    │  │ Inbound Replies  │
   │ post_claims_     │  │ Reply        │  │ scraper/reply.js │
   │ thread.js        │  │ proactive_   │  │                  │
   │                  │  │ reply.js     │  │ ← Layer 2:       │
   │ (Layer 1 only)   │  │              │  │   google_search  │
   │                  │  │ ← Layer 2:   │  │   grounding +    │
   │                  │  │   google_    │  │   source URLs    │
   │                  │  │   search +   │  │                  │
   │                  │  │   source URLs│  │                  │
   └──────────────────┘  └──────────────┘  └──────────────────┘
```

#### 1. Claims Thread (`runner/post_claims_thread.js`)

- **When**: Before posting the 2-tweet thread
- **What**: Calls `verifyClaim()` on the draft's claim text
- **Effect**: Appends the Veritas Lens URL to tweet2 if it fits within 280 chars. Logs verification metadata (status, confidence, verdict_label, lens_url) alongside the tweet in `posts_log.json`.
- **Fallback**: If verification fails or is unavailable, posts the thread without it.

#### 2. Proactive Replies (`runner/proactive_reply.js`)

- **When**: After selecting a high-engagement target post from `feed_digest.txt`
- **Pre-verification**: Calls `verifyClaim()` on the target post's text (if >30 chars)
- **Confidence gate**: If verification returns `unverified` with confidence < 40%, the reply is **skipped entirely** to avoid risk of hallucinated corrections. Logged as: `"verification too weak to engage"`.
- **Grounded drafting**: `draftReply()` calls `callGemini()` (from `runner/lib/sebastian_respond.js`) with `tools: [{ google_search: {} }]`. The drafting LLM can independently search the web while composing the reply — it is not limited to the pre-verification results.
- **Verification prompt block**: Feeds the full pre-verification result (verdict, confidence, summary, evidence URLs, framing analysis, lens URL) into the prompt as a `VERIFICATION RESULT` block, with critical grounding rules:
  - **Refuted**: Claim is PROVEN FALSE by evidence. LLM may correct with counter-evidence.
  - **Unverified**: Could not confirm or deny. NOT the same as false. LLM must NOT say the claim is wrong.
  - **Supported**: Claim checks out. LLM may cite evidence.
  - Explicit anti-hallucination instruction: "NEVER fabricate corrections. Only correct claims when you have specific counter-evidence from the sources above."
- **Source citation**: After drafting, grounding URLs are extracted from `res.raw.candidates[0].groundingMetadata.groundingChunks`. If the reply text is ≤247 chars, the first grounding URL is appended on a new line (X auto-shortens to ~23 chars via t.co, fitting within the 280-char limit).
- **Return shape**: `draftReply()` returns `{ text: string, sourceUrls: string[] }` (up to 3 URLs).
- **Caps**: 4 replies/day, 60min gap between replies
- **State**: `state/proactive_reply_state.json`
- **Interaction log**: Logs `source_urls` alongside the reply in both `proactive_reply_state.json` and `state/interactions.json`
- **Integration**: Added as step 8.5 in `runner/lib/post_browse.js`

#### 3. Inbound Replies (`scraper/reply.js`)

- **When**: Processing a mention (step 3b, after memory recall)
- **Pre-verification**: Calls `verifyClaim()` on mention text if >40 chars
- **Grounded drafting**: `geminiClassify()` calls the Vertex AI endpoint with `tools: [{ google_search: {} }]`. The drafting LLM can independently search the web while classifying the mention and composing a reply — it is not limited to the pre-verification results.
- **Verification prompt block**: Injects a `LIVE VERIFICATION` block into the `geminiClassify()` prompt alongside existing `verifiedHints` (cached DB lookups). The live block includes verdict, confidence, summary, evidence URLs, framing, and lens URL, with the same grounding rules as proactive replies:
  - **Refuted** = PROVEN FALSE by evidence. May correct using counter-evidence.
  - **Unverified** = COULD NOT CONFIRM OR DENY. NOT "false". Must NOT say the claim is wrong.
  - **Supported** = Claim checks out. May cite evidence.
  - "NEVER fabricate corrections. Only correct when you have specific counter-evidence from sources above."
- **Distinction from `verifiedHints`**: `verifiedHints` are cached keyword matches from the verification DB (older, broader). `liveVerification` is a fresh web-searched result for the specific claim in this mention.
- **Source citation**: After classification, grounding URLs are extracted from `data.candidates[0].groundingMetadata.groundingChunks`. If the reply text is ≤247 chars, the first grounding URL is appended on a new line before posting. Up to 3 URLs are returned in `verdict.sourceUrls`.
- **Return shape**: `geminiClassify()` returns `{ verdict, reply, reason, sourceUrls }`.
- **Fallback**: If `verify_claim.js` is not loadable or the call fails, proceeds without live verification (non-fatal). If the grounded Vertex call itself fails, the reply is posted without source URLs.

### Data Flow

```
mention/post text
    │
    ▼
verifyClaim({ claim, handle, url })                     ← LAYER 1: Pre-verification
    │
    ├── execFileSync → verify_one.js
    │     ├── web search (Gemini + Google Search grounding, BUILDER_CREDENTIALS)
    │     ├── claim_scorer.js (composite score)
    │     ├── persist to claim_verifications DB
    │     ├── re-export verification_export.json
    │     └── JSON stdout (last line)
    │
    ▼
{ claim_id, status, confidence, summary, verdict_label, lens_url, evidence_urls, framing }
    │
    │   ┌── Confidence gate (proactive_reply only):
    │   │   If status == "unverified" && confidence < 0.4 → ABORT (no reply)
    │   │
    ▼   ▼
Draft reply via Gemini + Google Search grounding         ← LAYER 2: Grounded drafting
    │
    ├── proactive_reply.js → callGemini({ tools: [{ google_search: {} }] })
    │     ├── LLM can independently search web while composing
    │     ├── Verification block injected as prompt context
    │     ├── Returns { text, raw } — raw includes groundingMetadata
    │     └── Extract grounding URLs from raw.candidates[0].groundingMetadata.groundingChunks
    │
    ├── scraper/reply.js → fetch(Vertex, { tools: [{ google_search: {} }] })
    │     ├── LLM can independently search web while classifying + composing
    │     ├── Verification block injected as prompt context
    │     ├── Returns { verdict, reply, sourceUrls }
    │     └── Extract grounding URLs from data.candidates[0].groundingMetadata.groundingChunks
    │
    ▼
Compose final reply text
    │
    ├── If reply ≤ 247 chars AND sourceUrls.length > 0:
    │     → Append first grounding URL on a new line (t.co shortens to ~23 chars)
    │     → Total: reply text + \n + URL ≤ 280 chars
    │
    ├── Claims thread: lens URL appended to tweet2
    ├── Proactive reply: reply text + source URL posted via CDP
    └── Inbound reply: reply text + source URL posted via X API
```

### Error Handling

All integrations treat verification as optional — a failed or timed-out call returns `null` and the pipeline continues without it. No verification failure can block a post or reply from going out.

**Layer 1 (pre-verification) failures**: `verifyClaim()` returns `null`. Reply proceeds without verification context in the prompt. The grounded drafting LLM (Layer 2) still has its own web search capability.

**Layer 2 (grounded drafting) failures**: If the Vertex API call with `google_search` fails, it falls back to the same error handling as before — the Gemini call throws, and the reply is skipped for that cycle. The `google_search` tool in Vertex is best-effort; if grounding returns no chunks, `sourceUrls` is an empty array and no URL is appended to the reply.

**Confidence gate**: Only applies to proactive replies. If `verify_one` returns `unverified` with confidence < 40%, the reply is skipped entirely (logged, not silent). This prevents the drafting LLM from attempting corrections on claims with insufficient evidence.

---

## Anti-Hallucination Safeguards (2026-04-19)

The verification pipeline includes multiple layers specifically designed to prevent the LLM from fabricating corrections to unverified claims.

### The Problem (Machado Incident)

On 2026-04-19, `verify_one.js` scored a claim about María Corina Machado at 0.36 confidence → status `"unverified"`. The old prompt told Gemini: "If this post makes a specific factual claim that is wrong **or unverified**, CORRECT IT." Gemini interpreted "unverified" as "false" and hallucinated: "She has not received a Nobel Prize" — when she had in fact won the 2025 Nobel Peace Prize.

### Root Cause

The prompt conflated two fundamentally different states:
- **Refuted**: Active evidence contradicts the claim (web_search returned "refuted")
- **Unverified**: Insufficient evidence to confirm or deny (low confidence, no counter-evidence)

Treating both the same way instructed the LLM to "correct" claims it simply hadn't found evidence for.

### Safeguards Now in Place

| Layer | Mechanism | Prevents |
|-------|-----------|----------|
| **1. Confidence gate** | Skip reply when `unverified` + confidence < 40% | Engaging with claims too uncertain to comment on |
| **2. Prompt distinction** | Explicit grounding rules: Refuted ≠ Unverified | LLM treating "don't know" as "false" |
| **3. Anti-hallucination instruction** | "NEVER fabricate corrections. Only correct when you have specific counter-evidence" | LLM inventing facts to fill gaps |
| **4. Grounded drafting (google_search)** | Drafting LLM can independently search the web | LLM relying solely on (possibly insufficient) pre-verification results |
| **5. Source citation** | Grounding URLs extracted and appended to replies | Readers can verify claims themselves |

### Prompt Grounding Rules (verbatim, injected in both pipelines)

```
CRITICAL GROUNDING RULES:
- "Refuted" means the claim is PROVEN FALSE by evidence. You may correct it
  with the counter-evidence above.
- "Unverified" means we COULD NOT CONFIRM OR DENY the claim. This is NOT
  the same as false. Do NOT say a claim is wrong just because it is
  unverified. You do not have enough evidence.
- "Supported" means the claim checks out. You may cite the evidence.
- NEVER fabricate corrections. Only correct claims when you have specific
  counter-evidence from the sources above.
```

### Proactive Reply Prompt Instructions (fact-checking section)

```
1. PRIORITY: If the verification says REFUTED, correct the claim using the
   specific counter-evidence provided. Lead with the correct information.
   Name the source. Be direct.
   If the verification says UNVERIFIED, do NOT claim the post is wrong.
   Instead, add context, a related observation, or engage with the topic —
   but NEVER assert something is false without evidence.
2. If the claim is supported, add what supports it or what context makes it
   more precise.
7. Use the verification evidence. If REFUTED, say so with counter-evidence.
   If UNVERIFIED, do NOT fabricate corrections.
```
