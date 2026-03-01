# Hunter Codebase Audit (2026-02-28)

## Scope notes
- Requested baseline docs missing from workspace: `ds_enhancements.md`, `stability.md`, `MEMORY.md`.
- Audited against code + `ARCHITECTURE.md` + runtime state.
- Validation run: `node --check runner/*.js scraper/*.js` (pass), `npm -C web run build` (fails in sandbox due blocked Google Fonts fetch, not app logic).

## Findings (ordered by severity)

1. **Critical: CDP sessions are closed with `browser.close()` in scripts that attach to a shared Chrome**
   - Shared connection helper uses `puppeteer.connect(...)` to an already-running browser: `runner/cdp.js:44`.
   - Multiple callers then invoke `browser.close()` instead of `disconnect()`: `scraper/collect.js:531`, `runner/post_tweet.js:137`, `runner/post_quote.js:161`.
   - Risk: closes the whole long-lived profile/session unexpectedly, causing cycle churn and flaky automation.

2. **Critical: ontology state/schema drift causes incorrect scoring and drift detection**
   - `state/ontology.json` stores numeric `evidence_log` entries instead of evidence objects: `state/ontology.json:13`, `state/ontology.json:27`, `state/ontology.json:53`, `state/ontology.json:103`.
   - Recompute logic assumes object fields (`e.trust_weight`, `e.pole_alignment`) and treats missing alignment as left by default: `runner/apply_ontology_delta.js:250-252`.
   - Result: legacy numeric entries bias scores/drift left and break trust-weight semantics.

3. **High: Playwright migration is incomplete**
   - New CDP helper is Puppeteer-based (`runner/cdp.js`), but reply/follow loops still use Playwright directly: `scraper/reply.js:22`, `scraper/follows.js:26`.
   - Dependencies still include both stacks (`scraper/package.json`, `runner/package.json`), increasing failure surface and doc/runtime mismatch.

4. **High: reply daily counter is double-incremented**
   - `logInteraction()` increments `today_count`: `scraper/reply.js:263`.
   - Main flow increments `today_count` again after posting: `scraper/reply.js:400`.
   - Effect: daily cap reached early, inaccurate rate limiting/metrics.

5. **High: unsanitized journal HTML is rendered with `dangerouslySetInnerHTML`**
   - Raw HTML is extracted from stored journal files: `web/lib/readJournals.ts:47`.
   - It is injected directly into the page: `web/app/journal/[date]/[hour]/page.tsx:65-68`.
   - Risk: stored XSS if generated journal content includes script-capable markup.

6. **Medium: architecture doc is stale vs implementation**
   - States browser automation is Playwright: `ARCHITECTURE.md:320` (partial/inaccurate now).
   - States tweet posting/git are still an LLM gap: `ARCHITECTURE.md:330-341`, but runner now posts via scripts and performs git operations in shell (`runner/run.sh:636-680`).
   - Collect pipeline described as “12-phase”: `ARCHITECTURE.md:49`; implementation includes additional phases and notifications pass (`scraper/collect.js:5-20`, `scraper/collect.js:528-529`).

7. **Medium: documented gravity formula differs from implemented scoring**
   - Doc formula uses exponent `1.5`: `ARCHITECTURE.md:280`.
   - Implementation uses `1.8`: `scraper/collect.js:77`.
   - This materially changes ranking behavior and should be reconciled.

8. **Medium: non-portable `grep -P` in main runner on macOS/bash 3.2 environments**
   - `run.sh` uses PCRE extraction: `runner/run.sh:326`.
   - BSD `grep` (default on macOS) does not support `-P`; fallback path runs but query-targeted memory recall is silently degraded.

9. **Medium: credentials are written into git remote URL**
   - Tokenized remote URL is persisted to local git config: `runner/run.sh:55-56`.
   - Increases accidental credential leakage risk in logs/config backups.

10. **Low: requested audit baseline docs are missing from repo**
   - Could not find `ds_enhancements.md`, `stability.md`, `MEMORY.md` anywhere in workspace.
   - This blocks a full “doc-vs-code” audit for the exact artifacts requested.

## Residual risks / testing gaps
- No automated schema validation for `state/ontology.json` and ontology delta application.
- No integration test that asserts “attach/disconnect only” behavior for shared CDP browser.
- No security test around journal HTML sanitization.
