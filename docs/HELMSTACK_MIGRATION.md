# CDP → HelmStack Migration — Handoff

_Last updated: 2026-07-05. Written for the next AI/engineer picking up the browser-automation migration._

## TL;DR

Hunter's browser automation is moving off the **legacy CDP Chrome** (a raw
`puppeteer.connect` to Chrome on port **18801**, via `runner/cdp.js`) onto
**HelmStack** (the user's own AI-native browser, an HTTP+SSE API on
`127.0.0.1:7070`). Reason: the raw CDP connect kept throwing `Network.enable
timed out` (Chrome memory bloat, ~5.4 GB / 45 procs), which silently dropped
posts, replies, and browse cycles. HelmStack manages its own browser and exposes
a stable HTTP API, so it doesn't hit that failure class.

**As of 2026-07-05 the orchestrator cycle is CDP-free and the two biggest
scraper consumers (`collect.js`, `follows.js`) are migrated. One scraper script
(`reply.js`) + some occasional posting/utility scripts remain on CDP.**

## Migration status

| Component | Runs | State | Notes |
|---|---|---|---|
| `runner/x_engage.js` (likes+replies) | every 3h | ✅ HelmStack | replies moved here from proactive_reply; verify-gate + fact-check |
| `runner/proactive_reply.js` | (retired) | ✅ retired | legacy CDP reply path; opt-in fallback behind `PROACTIVE_REPLY_CDP=1` |
| `runner/prefetch_url.js` | each browse cycle | ✅ no browser | drive was vestigial; now classifies source label from URL only |
| tweet / quote posting | on post | ✅ HelmStack | `POST_BACKEND=helmstack` → `post_x_helmstack.js` |
| LinkedIn post/engage | pipeline | ✅ HelmStack | `linkedin_*.js` |
| **`scraper/collect.js`** (feed_digest producer) | every 10 min | ✅ **HelmStack** (2026-07-05) | the big one; see below |
| `scraper/reply.js` (mention replies) | every 30 min | ❌ **CDP** | HARDEST — raw `createCDPSession` + `Input.insertText`; ~778 lines |
| `scraper/follows.js` | every 3h | ✅ **HelmStack** (2026-07-05) | via new `X.follow()`; honors `HELMSTACK_DRY_RUN=1` |
| `runner/post_thread.js` | occasional | ❌ CDP-only | threads still post via CDP even though tweets/quotes are on HelmStack |
| `post_claims_thread.js`, `post_article.js`, `post_and_pin.js`, `delete_tweet.js`, `delete_and_repost_quote.js`, `update_bio.js`, `check_notifs.js` | manual/occasional | ❌ CDP-only | no HelmStack branch |
| `runner/lib/gemini_agent.js` (agentic browse) | — | 💤 DEAD | not used while `useLocal()` (local qwen) → `single_pass_browse.js` runs instead |

### Recommended next steps (in order)
1. **Let `follows.js` bake** — runs every 3h; watch `scraper/scraper.log` for `[follows]` lines. `collect.js` (every 10 min) is confirmed healthy as of 2026-07-05 evening (`downloading images` marker present, `collect ok` ticks).
2. **`scraper/reply.js`** — the hardest. Uses a raw `page.createCDPSession()` + `Input.insertText` to defeat X's React contenteditable. HelmStack already solves this: `client.insertText(tabId, text)` is a browser-level CDP `Input.insertText` that reaches cross-origin frames. The X engine (`tools/helmstack-social/src/x.js`) already has a working `reply()` — reuse it. NOTE: `x_engage.js` now covers *proactive* replies on HelmStack; `scraper/reply.js` covers *inbound mention* replies. Confirm whether both are still needed before porting (they may be consolidatable).
3. **`post_thread.js`** — for posting consistency; the X engine supports post + chained replies, so a thread = `post()` then N × `reply()`.

## How the migration is done (the pattern)

The HelmStack client lives at `tools/helmstack-social/src/client.js` (wrapper:
`runner/lib/helmstack.js`). Key methods:
`openTab(url)`, `navigate(id,url)`, `evaluate(id,expr)→value`,
`evalFn(id, fn, ...jsonArgs)→value` (serializes fn+args, runs in page),
`tabUrl(id)`, `listTabs()`, `ensureTab(matcher,openUrl)→id`, `waitReady(id,opts)`,
`pollFn`, `screenshot(id)` (whole-tab only), `insertText/pressKey/clickAt`
(browser-level CDP — reach cross-origin iframes).

The **X engine** (`tools/helmstack-social/src/x.js`, class `X`) wraps a client
with X-specific helpers: `ensureTab()`, `sessionOk()` (checks auth_token/ct0
cookies), `gotoHome()`, `post()`, `quote()`, `reply()`, `like()`, `engage()`,
and the scrapers added for collect.js:
- `scrapeTimelineFull({limit,scrolls})` — home timeline, full fields.
- `scrapeThreadReplies(url,{limit})` — replies under a permalink (drops root).
- `scrapeMentions({limit})` — notifications/mentions page.
- `_scrapeArticles(max)` — the shared extractor (ported verbatim from the old
  `collect.js` extractPosts selectors), returns
  `{id,username,displayName,text,quotedText,quotedUsername,ts,likes,rts,replies,mediaType,mediaUrl,externalUrls}`.

**To migrate a CDP script:** replace `connectBrowser()`/`browser.newPage()` with
`new X(new HelmStackClient(), {ownHandle, log})` + `await x.ensureTab()` +
`sessionOk()`. Replace `page.goto` with `client.navigate`. Replace
`page.evaluate(fn)` with `client.evalFn(tab, fn, ...args)` — but note it returns
`.value`, so have the in-page fn `return JSON.stringify(...)` and `JSON.parse`
on the Node side (see `_scrapeArticles`). Keep all non-browser logic (scoring,
DB writes, formatting, dedup, API fallback) untouched.

### The one CDP capability with no HelmStack analogue
**Element-level screenshots** (`elHandle.screenshot()`). HelmStack only offers
whole-tab `screenshot(id)`. In `collect.js` this drove per-tweet media capture;
it was replaced by extracting the media `<img>.src` / `video[poster]` URL in the
scrape and downloading it directly (`fetchImageBase64` in collect.js — X media on
pbs.twimg.com is public, no auth). If you need element screenshots elsewhere:
whole-tab screenshot + crop by `getBoundingClientRect`, or navigate to the media
URL and full-screenshot.

### Wedged-tab gotcha (discovered 2026-07-05, fixed in the engine)
A long-lived X tab in HelmStack can wedge: **every navigation errors and snaps
back to `/home`** (tab shows `status: "error"`, `statusMessage: "Failed to load
…"`), while a *fresh tab in the same session* navigates fine. This is invisible
to `collect.js` (it only scrapes home) but silently breaks anything that
navigates cross-page (reply, follow, profile-confirm). The engine now guards
this with `X._gotoChecked(url)` — navigate, verify `tabUrl` actually landed,
and on mismatch close + reopen the tab at the target URL. Used by `reply()`,
`follow()`, `scrapeThreadReplies()`, `scrapeMentions()`, `_confirmFromProfile()`.
Use it for any new cross-page navigation in the engine.

## Testing / validation (important gotchas)

- **Per-directory `node_modules`.** There is NO top-level `node_modules`. Deps
  live in `scraper/node_modules` and `runner/node_modules`. To test a worktree
  copy, symlink those two into the worktree, run, then remove the symlinks:
  ```sh
  W=/Users/mondb/hunter/.claude/worktrees/<name>
  ln -sfn /Users/mondb/hunter/scraper/node_modules "$W/scraper/node_modules"
  ln -sfn /Users/mondb/hunter/runner/node_modules  "$W/runner/node_modules"
  # ... test ...  then: rm -f "$W/scraper/node_modules" "$W/runner/node_modules"
  ```
  Running from the worktree keeps writes isolated to the worktree's `state/` DB.
- **Dry-run first.** `x_engage.js` honors `HELMSTACK_DRY_RUN=1`. For scrapers,
  test the engine method read-only before wiring the consumer.
- **HelmStack must be running** on :7070 (the release build
  `apps/desktop/release/HelmStack.app`). Check: `curl -s -H "Authorization:
  Bearer $HELMSTACK_AUTH_TOKEN" http://127.0.0.1:7070/api/tabs`. The X session
  is transplanted by cookie into partition `persist:default` (survives restarts).
- **The X-API fallback stays.** `collect.js` (and mentions) fall back to the X
  API path on any HelmStack failure — keep it as the degradation path.

## Deploy flow (this repo)

- Code changes are made in a **git worktree branch**, then **merged to `main`
  in `/Users/mondb/hunter`** (`git merge --no-edit <branch>`).
- **Do NOT `git add -A`** — it sweeps runtime `state/*.json` files into your
  commit and causes merge conflicts against the runner's live writes. `git add`
  only the specific code files. If a merge aborts on a dirty `state/` file,
  `git checkout -- state/<file>` (the runner regenerates it) then merge.
- **The orchestrator** loads `runner/lib/*.js` at startup → needs
  `launchctl kickstart -k gui/$UID/com.sebastian.runner`, done in the **sleep
  window** right after a cycle finishes (watch for `Next cycle in Ns` in
  `runner/runner.log`; check the process isn't mid-cycle first).
- **The scraper loops** (`scraper/start.sh` → collect/reply/follows) spawn a
  **fresh `node` each tick**, so they pick up merged file changes automatically
  — no restart needed for scraper-only changes. Output → `scraper/scraper.log`.

## Known pre-existing issues (NOT caused by this migration)

- **Vision 403.** `runner/vision.js` (image description) calls Vertex and returns
  `HTTP 403: billing not enabled` on GCP project `sebastian-hunter`. Media images
  now download fine but descriptions are empty. The old CDP code hit the same
  403. Fix = enable GCP billing, or route image description to a local
  multimodal model. See [[hunter-llm-backend]] context below.
- **Chrome memory bloat** (~5.4 GB / 45 procs) is the root of the CDP timeouts.
  Even the remaining CDP scripts would benefit from a periodic Chrome restart
  until they're migrated.

## Related context (same 2026-07-05 session)

- **The brain runs on LOCAL Ollama `qwen2.5-agent`**, not Gemini
  (`OLLAMA_BASE_URL=localhost` → `useLocal()` in `runner/local_llm.js` routes all
  `callVertex`/`llm.generate` to local). Log/comment strings still say "Gemini"
  in places — stale. `builder_vertex.js` (gemini-2.5-pro) is still real Vertex if
  a stronger model is needed.
- **`runner/lib/refine.js`** — a global, recursive, local-qwen discourse
  refinement primitive (critique→optional-revise; coherence/one_topic/
  specificity/falsifiability). Wired into `post_thread.js` and `linkedin_draft.js`
  as coherence gates. Available for other surfaces. Revise is opt-in (small model
  garbles rewrites); reject is the guard.
- **Engagement fixes:** `x_engage.js` relevance scorer is now a local-LLM 0-3
  rating (was keyword-substring vs abstract axis labels → always 0); threshold
  `X_RELEVANCE_MIN=2`. `proactive_reply.js` gained a 48h skip-ledger
  (`state/x_reply_skips.json`) so SKIP'd candidates aren't retried forever.

See also: `docs/PIPELINE.md`, `docs/DATA_COLLECTION.md`, `docs/ARCHITECTURE.md`.
