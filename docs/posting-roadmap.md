# Sebastian posting — roadmap & remaining work

Captured 2026-07-15, updated same day (quote/reply API migration + retweet action session). Context for the next build session (human or the META builder).

## Done (all committed; API paths validated by live dry-run)

- **X tweets via API** — `X.post()` uses X's `CreateTweet` GraphQL (in-page fetch, session `ct0`, queryId extracted from the bundle, empty `features`). No composer → no double/triple-paste. Composer kept as fallback; `X_POST_VIA_API=0` forces it.
- **X quotes + replies via API** — `X.quote()` / `X.reply()` are API-first: `postViaApi` now takes `attachmentUrl` (quote) and `replyToTweetId` (reply → `variables.reply = {in_reply_to_tweet_id, exclude_reply_user_ids:[]}`). Composer flows kept as fallback (`_quoteViaComposer` / `_replyOnPage`); the quote mentions-guard still loads the source page first. `X_POST_VIA_API=0` forces the composer. Shared machinery generalized: `_graphqlQueryId(opName)` (per-op cache) + `_graphqlMutation(opName, variables)` (queryId-rotation retry).
- **X repost (retweet)** — `X.retweet()` / `X.unretweet()` via `CreateRetweet`/`DeleteRetweet` mutations (API-only, no UI fallback; "already retweeted" treated as success). Manual/queue entry point: `runner/x_repost.js <url> [--undo] [--topic t]` (self-repost guard, `HELMSTACK_DRY_RUN=1` supported), logs via `posts_log.logRepost` (`type:"repost"` + `source_handle`/`topic` for the future learn-loop).
- **X images** — `X.postImage()`: browser upload via HelmStack file-input (CDP `setFileInputFiles`) + guarded text insert.
- **LinkedIn images** — `LinkedIn.postImage()`: voyager media pipeline (register `voyagerVideoDashMediaUploadMetadata?action=upload` → PUT bytes to `singleUploadUrl` → `normShares` with `media:[{category:"IMAGE", mediaUrn, tapTargets:[]}]`). Used because the LI composer is iframe-isolated.
- **Source images** — `lib/source_image.js`: fetch a source's `og:image` server-side (no CORS) → temp file → cleanup. Attribution `📷 via <source>`.
- **LinkedIn post learn-loop** — `lib/linkedin_performance.js` + `linkedin_measure.js`: tag each post with an opening technique, scrape reactions+comments, feed technique→engagement back into the draft prompt (explore/exploit).
- Fixed `findOwnTweetUrl` navigating to `x.com/undefined` (`this.ownHandle` → `this.handle`).
- **Image auto-trigger (X)** — `compose_tweet.js` now sets `state/tweet_image_source.txt` autonomously via `lib/lead_source_image.js`: extracts source URLs from the same browse notes the tweet was composed from, scores each by word-overlap relevance to the drafted tweet, and picks the top candidate that actually exposes an og:image (fetch-probe, HTML only). No match → no file → text-only post (unchanged). Deterministic (no extra LLM call); `IMAGE_AUTO_TRIGGER=0` disables. Attribution improved in `source_image.hostLabel`: an X status now credits the author `@handle` (its og:image is the tweet's own media) instead of a bare "x.com".

## ~~Follow-up 1 — image auto-trigger (small)~~ — DONE (X + LinkedIn)

Both channels now set their image source autonomously via `lib/lead_source_image.js`:
- **X** — `compose_tweet.js` writes `state/tweet_image_source.txt` from the browse notes.
- **LinkedIn** — `linkedin_draft.js` calls `pickLeadSource(text, pack.text)` over the content pack and stashes the winner in the outbox item's `meta.image_source` (JSON-persisted, read back by `linkedin_post.js`).
Both are best-effort (miss → text-only, unchanged), deterministic (no extra LLM call), and gated by `IMAGE_AUTO_TRIGGER=0`.

## Item 3 — LEARN repost + quote, all channels (large; the main remaining ask)

Two layers. Layer 1 is done for X (quote via API + retweet action) and LinkedIn (UI-driven reshare, below); only FB share remains. Layer 2 (the learn-loop over what gets amplified) is still to build on top.

### Layer 1 — the actions (build per channel)
- **X quote** — DONE (API-first, see above).
- **X repost (retweet)** — DONE (`X.retweet`/`unretweet` + `runner/x_repost.js`, see above). Still needs an autonomous trigger: nothing selects what to repost yet (that selection is where the layer-2 loop plugs in).
- **LinkedIn reshare** — DONE (UI-driven), via `LinkedIn.reshare(idx)` + `LinkedIn.deleteReshare(profileUrl, match)`.
  - **Definitive finding (2026-07-16, live capture):** an instant repost is **NOT a voyager JSON endpoint** — it fires a single Server-Driven-UI / React-Server-Component action: `POST /flagship-web/rsc-action/actions/server-request?sduiid=com.linkedin.sdui.feed.requests.createInstantRepost&parentSpanId=<nonce>`. The payload is RSC-serialized and carries a **render-scoped `parentSpanId`**, so it can't be replayed with a same-origin fetch the way `post()` is — there is no stable JSON API to mirror. (This is also why the bundle-grep for `normShares`/`resharedUpdate`/etc. found nothing: reshare doesn't use them.) Capture method that finally worked: diff `performance.getEntriesByType('resource')` before/after the reshare — main-thread `fetch`/`XHR`/`sendBeacon` interceptors all saw nothing (the app holds native refs / uses the SW).
  - **Implementation:** `reshare(idx)` clicks the Repost control → the instant "Repost" menu item on the feed post stamped by `scrapeFeed`, and confirms via the polled "Repost successful" toast (verified live: creates a real reshare, `{ok:true}`). `deleteReshare(profileUrl, match)` retracts it from `…/recent-activity/all/`: it drives the reshare item's ⋯ menu → "Delete repost" → the "Delete repost?" confirm with **real CDP pointer clicks** (`clickAt`), because a synthetic `.click()` does NOT open LinkedIn's control menu, and the top item's caret must be pushed clear of the sticky nav first (`scrollTo(0,120)` → caret ~y117). Undo confirmed live (profile returns to zero reshares).
  - **Known limitation:** `deleteReshare` is reliable as a **fresh, standalone** operation; running many delete cycles inside one long-lived process/tab degrades (menu stops opening) — the learn-loop should call it per-invocation, not loop it in-process.
- **Facebook share** — NEW + HARD. FB is automation-hostile (observation-only today; trusted-CDP clicks only). Likely defer or last.

### Layer 2 — the learn-loop (mirror the LinkedIn posting loop) — CORE DONE
The measure→correlate→select machinery is built as `lib/amplify_performance.js`
(same architecture as `lib/linkedin_performance.js` / the prediction-calibration loop):
- **Tag** — `recordAmplification(ourUrl, {channel, sourceHandle, topic, technique, sourceUrl, measurable})`. Wired at the X repost site (`x_repost.js`, `measurable:false` — a bare retweet has no own engagement surface, so it records WHAT we amplified but never blocks the measure queue) and the X quote site (`post_x_helmstack.js`, `measurable:true`).
- **Measure** — `runner/amplify_measure.js` (scheduled in `runSocialPipeline`, 12h gate) scrapes each due amplification's engagement: X via the new `X.scrapeTweetEngagement(url)` (parses the combined action-bar aria-label → likes/replies/reposts; live-validated), LinkedIn via the existing `scrapePostEngagement`. `engagement = reactions + comments`.
- **Correlate + select** — `sourceStats()`/`topicStats()` average engagement per source/topic; `pickAmplifyTarget(candidates)` chooses what to amplify next via force-explore-under-sampled → epsilon-greedy → exploit-highest-avg (unit-tested); `summaryText()` renders the track record. `AMPLIFY_MIN_SAMPLES`/`AMPLIFY_EPSILON` tune it.

**Autonomous trigger — DONE for X** (`runner/x_amplify.js`, scheduled 6h): scrapes
the timeline, scores each candidate by conviction-relevance (shared
`lib/content_relevance` scorer) AND learned source value, `pickAmplifyTarget`
chooses, `X.retweet` fires, `recordAmplification` tags it. One repost/run, ledgered
(`state/x_amplified.json`); own/already-amplified/low-relevance/guarded content
excluded. Operator kill-switch: `control.reposts` (via `x_control`). The X loop now
closes end-to-end: **select → act → measure → correlate → bias next select.**

Note (live-validated): `CreateRetweet` must be sent WITHOUT a `features` field
(with it → 404; `CreateTweet` is the opposite) and 404s intermittently — `x.js`
now retries once on transient 404/5xx (not on 400/401/403/429, so posting can't
double-fire). `retweet`/`unretweet` verified live (profile confirmed clean after undo).

**LinkedIn amplify trigger — DONE** (`runner/linkedin_amplify.js`, scheduled 8h): the
parallel of `x_amplify`. Scrapes the feed → scores each candidate (LinkedIn-tuned
scorer + shared guards) AND learned source value → `pickAmplifyTarget` → `LinkedIn.reshare(idx)`
→ reads the reshare's own permalink back (`LinkedIn.latestReshareUrl`, via the
recent-activity `data-urn`) → tags it `measurable:true`. One reshare/run, ledgered.
Live-verified end-to-end (reshare published, URL captured, tagged; then cleaned up).
Note: `scrapeFeed`'s author field is empty against LinkedIn's current obfuscated
DOM, so the script parses the author from the feed-card text (unit-tested on the
real "Recommended for you" / "reposted this" / "likes this" formats).

**Still to wire (smaller follow-ups):**
- **X quote-with-commentary as an amplify technique** — `x_amplify` currently fires only a bare repost; a quote earns richer (measurable) engagement but needs composed commentary on top of the already-built quote API path.
- **Fix `scrapeFeed` author extraction** in the shared engine (obfuscated LinkedIn DOM) so the text-parse fallback in `linkedin_amplify` isn't needed and `linkedin_engage`/`collect` get real authors too.

### Suggested order
1. ~~X quote→API + X retweet action.~~ DONE.
2. ~~LinkedIn reshare action.~~ DONE (UI-driven — `LinkedIn.reshare`/`deleteReshare`).
3. ~~Learn-loop core + autonomous X trigger.~~ DONE.
4. ~~LinkedIn amplify trigger.~~ DONE (`linkedin_amplify.js` + `LinkedIn.latestReshareUrl`). **Both channels' amplification loops are now live end-to-end.**
5. FB share — only if the FB automation surface improves.

## Reusable machinery already in place
- In-page authed fetch pattern (X: `ct0` + web bearer + dynamic queryId; LinkedIn: JSESSIONID csrf) — see `X._graphqlMutation` (generic: any bundle-declared mutation by operationName) and `LinkedIn.post`/`postImage`.
- `_confirmFromProfile` / `findOwnTweetUrl` for post confirmation (note the `post_unconfirmed` false-negative: always re-scan the profile rather than trust the confirm).
- HelmStack tab cleanup keeps one canonical tab per surface (prevents the wedged-tab bugs that break composer flows).
