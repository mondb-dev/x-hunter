# Sebastian posting — roadmap & remaining work

Captured 2026-07-15. Context for the next build session (human or the META builder).

## Done (this session, all committed + validated live)

- **X tweets via API** — `X.post()` uses X's `CreateTweet` GraphQL (in-page fetch, session `ct0`, queryId extracted from the bundle, empty `features`). No composer → no double/triple-paste. Composer kept as fallback; `X_POST_VIA_API=0` forces it.
- **X images** — `X.postImage()`: browser upload via HelmStack file-input (CDP `setFileInputFiles`) + guarded text insert.
- **LinkedIn images** — `LinkedIn.postImage()`: voyager media pipeline (register `voyagerVideoDashMediaUploadMetadata?action=upload` → PUT bytes to `singleUploadUrl` → `normShares` with `media:[{category:"IMAGE", mediaUrn, tapTargets:[]}]`). Used because the LI composer is iframe-isolated.
- **Source images** — `lib/source_image.js`: fetch a source's `og:image` server-side (no CORS) → temp file → cleanup. Attribution `📷 via <source>`.
- **LinkedIn post learn-loop** — `lib/linkedin_performance.js` + `linkedin_measure.js`: tag each post with an opening technique, scrape reactions+comments, feed technique→engagement back into the draft prompt (explore/exploit).

## Follow-up 1 — image auto-trigger (small)

Image posting is wired + works **when a source URL is set** (X: `state/tweet_image_source.txt`; LinkedIn: outbox `meta.image_source`), but nothing sets it autonomously. The compose step should pick a lead source-with-image (e.g. from the content pack / a referenced article or tweet) and populate that. The capability + cleanup are complete; this is just the trigger.

## Follow-up 2 — retire composer from quotes/replies (medium)

`X.quote()` and `X.reply()` still use the composer (can still double). Migrate to the API:
- Quote: `CreateTweet` with `variables.attachment_url = "<source tweet url>"`.
- Reply: `CreateTweet` with `variables.reply = {in_reply_to_tweet_id, exclude_reply_user_ids:[]}`.
Reuse `postViaApi`'s queryId + bearer + ct0 machinery — just extend the variables.

## Item 3 — LEARN repost + quote, all channels (large; the main remaining ask)

Two layers. Most of layer 1 doesn't exist yet.

### Layer 1 — the actions (build per channel)
- **X quote** — exists (`X.quote`), composer-based → migrate to API (see Follow-up 2).
- **X repost (retweet)** — NEW. GraphQL `CreateRetweet` mutation (extract its queryId from the bundle the same way as CreateTweet; body `{variables:{tweet_id, dark_request:false}, queryId}`). Un-retweet = `DeleteRetweet`.
- **LinkedIn reshare** — NEW. Voyager: reshare an update via `contentcreation/normShares` with the reshared activity URN as the parent/`resharedUpdate` (reverse-engineer the exact field), or the dedicated reshare endpoint. Same JSESSIONID-CSRF fetch pattern.
- **Facebook share** — NEW + HARD. FB is automation-hostile (observation-only today; trusted-CDP clicks only). Likely defer or last.

### Layer 2 — the learn-loop (mirror the LinkedIn posting loop)
Once the actions exist:
- Tag each repost/quote with **what** was reposted/quoted (source handle/topic/axis) and the technique (bare repost vs quote-with-commentary; commentary style).
- Measure the engagement it earned (per channel's metric scrape).
- Correlate → feed back into the selection: *which sources/topics/commentary styles are worth amplifying*. Same architecture as `lib/linkedin_performance.js` and the prediction-calibration loop.

### Suggested order
1. X quote→API + X retweet action.
2. LinkedIn reshare action.
3. Learn-loop over X repost/quote (measure via the profile), then extend to LinkedIn.
4. FB share — only if the FB automation surface improves.

## Reusable machinery already in place
- In-page authed fetch pattern (X: `ct0` + web bearer + dynamic queryId; LinkedIn: JSESSIONID csrf) — see `X.postViaApi` and `LinkedIn.post`/`postImage`.
- `_confirmFromProfile` / `findOwnTweetUrl` for post confirmation (note the `post_unconfirmed` false-negative: always re-scan the profile rather than trust the confirm).
- HelmStack tab cleanup keeps one canonical tab per surface (prevents the wedged-tab bugs that break composer flows).
