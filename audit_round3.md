# Audit Round 3 — Full Codebase Review

**Date:** 2026-03-15  
**Scope:** Complete read of run.sh (1285 lines), all 15+ runner JS scripts, all major scraper scripts, state file integrity check  
**Auditor:** Copilot

---

## CRITICAL — Must Fix

### 1. HEALTH watchdog permanently stuck after log rotation

**File:** `runner/watchdog.js` L345–370, `state/health_state.json`  
**Impact:** No error detection since March 6 (9 days)

The HEALTH watchdog stores `last_line: 19150` in `health_state.json`. After log rotation (`cp runner.log → archive; truncate to 0`), the current `runner.log` has only 6,907 lines. The watchdog does:

```js
newLines = lines.slice(lastLine);  // lines.slice(19150) on a 6907-line file → []
```

This yields an empty array, so it prints "no new log lines to scan" and exits. **Every subsequent log rotation resets the file to 0 but never resets the saved position**, so the health watchdog is permanently blind until the log happens to grow past 19,150 lines again.

**Fix:** Add a bounds check — if `lastLine > totalLines`, reset to `0`:

```js
if (lastLine > totalLines) {
  console.log(`[watchdog] HEALTH: log rotated (saved position ${lastLine} > current ${totalLines} lines) — rescanning from start`);
  lastLine = 0;
}
newLines = lines.slice(lastLine);
```

---

### 2. `generate_daily_report.js` "Highest-confidence axes" always empty

**File:** `runner/generate_daily_report.js` L44  
**Impact:** Every daily belief report has "- (none with confidence > 0 yet)" in the most important section

The code reads `belief_state.json` for the `activeAxes` section:

```js
const activeAxes = (belief?.axes || []).filter(a => (a.confidence || 0) > 0);
```

But `belief_state.json` contains:
```json
{"day": 0, "scores": {}, "phase": "tweet_cycle"}
```

There is no `.axes` field — it's a vestigial file from an earlier format. Meanwhile `ontology.json` has 29 axes with real confidence values. The `highConf` section of the report is built from `activeAxes`, which is always empty.

**Fix:** Use `axes` (from ontology.json) for the highConf section, not `activeAxes`:

```js
const highConf = axes
  .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
  .slice(0, 3)
  .map(a => `- \`${a.id}\`: conf ${((a.confidence || 0) * 100).toFixed(0)}%, score ${(a.score || 0).toFixed(3)}`)
  .join("\n") || "- (none with confidence > 0 yet)";
```

---

## HIGH — Should Fix Soon

### 3. 45% of posts missing `tweet_url` — URL capture failing

**File:** `runner/post_tweet.js` L150–180, `runner/post_quote.js` L230–260  
**Impact:** 9 of 20 posts in `posts_log.json` have empty `tweet_url` (all from March 13–15)

After clicking Post, both scripts:
1. Check if the page URL contains `/status/` — often fails because X doesn't redirect to the new tweet
2. Navigate to the profile page and scrape the first tweet link — fails if X is slow or the DOM hasn't loaded

The profile fallback uses a 3-second wait, but if X's SPA hasn't rendered the timeline, the `querySelectorAll` returns nothing. Additionally, the `Array.from` call can fail on OpenClaw's modified browser environment (the `Array.from1` errors seen earlier).

**Fix options:**
- **A)** Increase the profile page wait from 3s to 5–8s
- **B)** Add a retry loop: wait 2s, check DOM, wait 2s more, check again (up to 3 attempts)
- **C)** Use `page.waitForSelector('a[href*="/status/"]', { timeout: 10000 })` instead of a blind sleep

Option B recommended — most resilient.

### 4. Moltbook rate limiter drops non-ponder posts silently

**File:** `runner/moltbook.js`, `runner/run.sh` daily block (L1130–1230)  
**Impact:** Article, checkpoint, and sprint Moltbook posts may be permanently lost

The daily block calls 4 moltbook posts sequentially:
1. `--post-article` (line 1137)
2. `--post-checkpoint` (line 1165)
3. `--post-ponder` (line 1208)
4. `--sprint-update` (line 1226)

Each has a 32-minute rate limit (`MIN_POST_INTERVAL_MS`). The first one posts; the next three hit the rate limiter and silently return. Only `--post-ponder` has a persistent retry flag (`ponder_post_pending`). The other three have no retry mechanism — they're lost unless the daily block happens to run again with enough spacing.

**Fix:** Add `sleep 2000` (32 min) between moltbook calls in the daily block, OR add similar pending flag files for article/checkpoint/sprint moltbook posts and retry each browse cycle.

---

## MEDIUM — Non-Urgent Improvements

### 5. `posts_log_delta.json` is an orphan file

**File:** `state/posts_log_delta.json` (402 bytes)  
**Impact:** Harmless dead file — no code references it

Searched entire codebase: zero references to `posts_log_delta`. Contains a single entry from March 13. Likely a manual debug artifact.

**Fix:** `rm state/posts_log_delta.json` and add to `.gitignore` if it shouldn't recur.

### 6. `feed_digest.txt` owned by `wheel` group

**File:** `state/feed_digest.txt`  
**Impact:** Potential permission issues if scripts run as a different user/group

```
-rw-r--r--@ 1 mondb  wheel  584152 Mar 15 12:17 state/feed_digest.txt
```

All other state files are `mondb:staff`. The `wheel` group ownership is unusual and suggests the file was created by a root-level process or a different user session.

**Fix:** `chown mondb:staff state/feed_digest.txt`

### 7. `belief_state.json` is vestigial — remove or repurpose

**File:** `state/belief_state.json` (56 bytes)  
**Impact:** Misleading data — code reads it but it never has useful content

The file has `{"day": 0, "scores": {}, "phase": "tweet_cycle"}` and has never been updated. `ontology.json` is the real belief store. `generate_daily_report.js` reads it (bug #2 above), and `ponder.js` has fallback logic for it. Since nothing writes to it, it's dead weight that causes silent data gaps.

**Fix:** Remove the `belief_state.json` dependency from `generate_daily_report.js` (see #2) and `ponder.js`. Either delete the file or document it as deprecated.

### 8. No rate-limit gap between tweets in the daily block

**File:** `runner/run.sh` L1125–1200  
**Impact:** X may rate-limit or shadow-ban rapid consecutive posts

The daily block posts an article tweet, then a checkpoint tweet, then a ponder tweet, then a sprint tweet — each with only `sleep 10` between them. Four tweets in under a minute looks automated and risks X's rate limiter.

**Fix:** Increase the gap between daily block tweets to at least 60 seconds each.

---

## LOW — Observations

### 9. `.env` parsing doesn't handle quoted values

**Files:** 8 scripts with identical inline `.env` parser  
**Impact:** If any `.env` value contains quotes (e.g., `KEY="value with spaces"`), the quotes become part of the value

All parsers use:
```js
const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
if (m) process.env[m[1]] = m[2].trim();
```

This doesn't strip surrounding quotes. Currently harmless because no values use quotes, but brittle if someone adds one.

**Fix (optional):** Extract to a shared `loadEnv.js` utility that strips quotes:
```js
process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
```

### 10. `ponder.js` `loadAxes()` multi-format fallback is defensive but fragile

**File:** `runner/ponder.js`  
**Impact:** If ontology format changes again, the fallback chain may silently load stale data from `belief_state.json`

The function tries `ontology.axes` (array), `Object.values(ontology)` (object), then falls back to `belief_state.json`. The third path always returns `{day: 0, scores: {}}` which has no axes. This means ponder could silently see zero axes if the ontology format ever changes—disabling the entire ponder pipeline without error.

### 11. `seen_ids.json` growing without bound

**File:** `state/seen_ids.json` (270KB)  
**Impact:** Unbounded growth — no trimming mechanism

The file stores all seen tweet IDs to prevent re-processing. At 270KB it's manageable, but with ~100+ new IDs per day, it'll grow indefinitely. After a year that's ~10MB of JSON parsed on every cycle.

**Fix (optional):** Trim to the last N days (e.g., 30 days) during the daily maintenance block.

### 12. `discourse_anchors.jsonl` + `curiosity_log.jsonl` have no rotation

**Files:** `state/discourse_anchors.jsonl`, `state/curiosity_log.jsonl`  
**Impact:** Append-only files grow without bound

Unlike `runner.log` which gets rotated in the daily block, these JSONL files just keep growing.

---

## Summary

| # | Severity | Issue | Effort |
|---|----------|-------|--------|
| 1 | **CRITICAL** | HEALTH watchdog stuck after log rotation | 5 min |
| 2 | **CRITICAL** | Daily report highConf always empty (reads vestigial file) | 5 min |
| 3 | **HIGH** | 45% of posts missing tweet_url | 15 min |
| 4 | **HIGH** | Moltbook rate limiter drops non-ponder posts | 20 min |
| 5 | MEDIUM | Orphan `posts_log_delta.json` | 1 min |
| 6 | MEDIUM | `feed_digest.txt` wrong group ownership | 1 min |
| 7 | MEDIUM | `belief_state.json` vestigial | 10 min |
| 8 | MEDIUM | No tweet rate-limit gap in daily block | 5 min |
| 9 | LOW | `.env` parser doesn't handle quotes | 15 min |
| 10 | LOW | `ponder.js` multi-format fallback fragile | 10 min |
| 11 | LOW | `seen_ids.json` growing without bound | 10 min |
| 12 | LOW | JSONL files not rotated | 5 min |

**Recommended fix order:** #1 → #2 → #3 → #8 → #5 → #6 → #4
