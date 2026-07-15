# HelmStack dogfooding feedback — 2026-07-15

**Period:** Recent production runtime  
**Summary:** Text insertion into composer fields is failing verification 22 times in logs—the single highest-impact issue blocking reliable posting. The root cause appears to be race conditions or synthetic input rejection: inserted text either doesn't appear, appears truncated, or clears unexpectedly. Second-tier issues include missing DOM elements (5×), timeouts during CDP operations (4×), and tab state bugs (wedged navigation, false-negative post confirmation). Composer reliability is the P0 blocker; the rest are P1 operational friction.

---

## 1. **Composer text insertion unreliable** – P0
**Impact:** Posts fail to publish; 22 logged insertion failures across X and likely other platforms. After 3 retries, drafts are discarded. This is the primary runtime failure mode.

**Frequency:** 22 occurrences  
**Example:**
```
[post_tweet.hs] text verify miss 1/3 (34/290)
[post_tweet.hs] text verify miss 2/3 (34/290)
[post_tweet.hs] text verify miss 3/3 (34/290)
[post_tweet.hs] insert unverified after 3 attempts — discarding draft
```

**Suggestion:**  
- Add a **`composeText(selector, text, { verify: true, trusted: true })`** method that:
  - Uses trusted input events (`isTrusted=true`) for platforms that filter synthetic typing
  - Polls `element.value` / `element.textContent` after insertion with a short settle delay (100–300ms)
  - Returns `{ inserted: number, expected: number, retries: number }` so agents can detect partial writes
- Expose **`clearComposer(selector)`** that explicitly dispatches `selectAll + delete` or sets `.value = ''` with change events, avoiding reliance on manual selection logic

---

## 2. **Selector/DOM element not found** – P1
**Impact:** Follow actions, reply attempts, and engagement operations silently fail when buttons are missing or selectors drift. 5 logged instances across Facebook and X.

**Frequency:** 5 occurrences  
**Example:**
```
[x_engage] reply attempt failed (reply_button_not_found) — recycling tab and retrying once
[fb_seed_follows] PCIJ: no_follow_button_or_already
```

**Suggestion:**  
- Add **`waitForAnySelector(selectors[], timeout)`** that returns `{ found: string | null, index: number }` so agents can handle A/B-tested or conditional UI (e.g., "Follow" vs. "Following" vs. absent).
- Return **structured miss reasons** from `click()` / `waitForSelector()`: `{ found: false, reason: 'timeout' | 'removed' | 'hidden' | 'noMatch' }` instead of generic failures, enabling smarter retry logic.

---

## 3. **Timeouts during CDP operations** – P1
**Impact:** Node spawns and Network.enable calls block indefinitely, wedging workflows. 4 logged timeouts.

**Frequency:** 4 occurrences  
**Example:**
```
[verify_claim] error: spawnSync node ETIMEDOUT
2026-07-13 23:23:25.290 HelmStack[1073:6930570] NSSpellServer dataFromCheckingString timed out
```

**Suggestion:**  
- Enforce **per-operation timeout defaults** (5–10s for CDP commands, 30s for navigation) and expose them in the API: `setDefaultTimeout(ms)` or per-call `{ timeout: number }`.
- Add **timeout telemetry**: log slow CDP round-trips (>1s) and surface them in a `getPerformanceMetrics()` call so agents can detect environment degradation.

---

## 4. **Tab navigation wedges / snaps back** – P1
**Impact:** Tabs fail to navigate to the target URL and remain stuck on prior page, requiring tab recycling. 2 logged occurrences.

**Frequency:** 2 occurrences  
**Example:**
```
[post_quote.hs] nav to https://x.com/SebastianHunts did not land — recycling wedged tab
```

**Suggestion:**  
- Expose **`getNavigationState(tabId)`** returning `{ url: string, loadState: 'loading' | 'interactive' | 'complete', redirected: boolean }` so agents can detect snap-back or incomplete navigation.
- Add **`navigate(url, { waitUntil: 'networkIdle' | 'load' | 'domContentLoaded' })`** with explicit settle contracts and reject the promise if `window.location.href` doesn't match the target after the wait condition.

---

## 5. **Post confirmation false negatives** – P2
**Impact:** Agent retries or reports failure even though the post succeeded, causing duplicate attempts or incorrect logs. 2 logged instances.

**Frequency:** 2 occurrences  
**Example:**
```
[watchdog] QUOTE retry also failed — post_unconfirmed
```

**Suggestion:**  
- Add **`awaitPostConfirmation(selector, { timeout: 10000, pollInterval: 500 })`** that:
  - Waits for post-success UI signals (toast, redirect, new post in DOM)
  - Returns `{ confirmed: boolean, url?: string, timestamp?: number }`
- Provide a **`getLastRequest(filter)`** helper to inspect Network events for `POST /CreateTweet` or equivalent, enabling agents to cross-check backend success independently of UI.
