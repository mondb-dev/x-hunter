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

## ~~Follow-up 1 — image auto-trigger (small)~~ — DONE (X)

Done for X (above). LinkedIn's image trigger (outbox `meta.image_source`) is still unset autonomously — the LinkedIn draft path (`runner/linkedin_draft.js`) could call the same `pickLeadSource(text, notes)` and stash the result in the outbox item's `meta.image_source`. Small follow-up, same helper.

## Item 3 — LEARN repost + quote, all channels (large; the main remaining ask)

Two layers. Layer 1 is done for X (quote via API + retweet action, above); LinkedIn reshare and FB share remain.

### Layer 1 — the actions (build per channel)
- **X quote** — DONE (API-first, see above).
- **X repost (retweet)** — DONE (`X.retweet`/`unretweet` + `runner/x_repost.js`, see above). Still needs an autonomous trigger: nothing selects what to repost yet (that selection is where the layer-2 loop plugs in).
- **LinkedIn reshare** — NEW. Voyager: reshare an update via `contentcreation/normShares` with the reshared activity URN as the parent/`resharedUpdate` (reverse-engineer the exact field), or the dedicated reshare endpoint. Same JSESSIONID-CSRF fetch pattern.
  - **Recon note (2026-07-15):** grepping the loaded LI JS bundles for the reshare field names is a DEAD END — `normShares`, `resharedUpdate`, `RESHARE*`, `parentUrn`, `reshareContext` all return **zero** literal hits even though `post()` clearly hits `normShares` (the path + field names are built dynamically, not string literals). Unlike X's `CreateTweet` queryId, there's nothing to extract statically. The reliable path is to **capture the real reshare request** (endpoint + body shape) from the HelmStack network log while performing one live reshare via the UI (then undo) — but that's a public publish action, so it needs the operator's go-ahead before running. Once the body shape is known, mirror it in a `LinkedIn.reshare(activityUrn, commentary?)` using the same JSESSIONID-CSRF voyager fetch as `post()`.
- **Facebook share** — NEW + HARD. FB is automation-hostile (observation-only today; trusted-CDP clicks only). Likely defer or last.

### Layer 2 — the learn-loop (mirror the LinkedIn posting loop)
Once the actions exist:
- Tag each repost/quote with **what** was reposted/quoted (source handle/topic/axis) and the technique (bare repost vs quote-with-commentary; commentary style).
- Measure the engagement it earned (per channel's metric scrape).
- Correlate → feed back into the selection: *which sources/topics/commentary styles are worth amplifying*. Same architecture as `lib/linkedin_performance.js` and the prediction-calibration loop.

### Suggested order
1. ~~X quote→API + X retweet action.~~ DONE.
2. LinkedIn reshare action.
3. Learn-loop over X repost/quote (measure via the profile), then extend to LinkedIn. Repost selection (what's worth amplifying) + the autonomous trigger for `X.retweet` live here; `logRepost` already records `source_handle`/`topic` to correlate against.
4. FB share — only if the FB automation surface improves.

## Reusable machinery already in place
- In-page authed fetch pattern (X: `ct0` + web bearer + dynamic queryId; LinkedIn: JSESSIONID csrf) — see `X._graphqlMutation` (generic: any bundle-declared mutation by operationName) and `LinkedIn.post`/`postImage`.
- `_confirmFromProfile` / `findOwnTweetUrl` for post confirmation (note the `post_unconfirmed` false-negative: always re-scan the profile rather than trust the confirm).
- HelmStack tab cleanup keeps one canonical tab per surface (prevents the wedged-tab bugs that break composer flows).
