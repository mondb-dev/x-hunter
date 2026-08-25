# Outbound Pipeline

Everything Sebastian says in public flows: **compose → gates → queue → channel
engine → measure**.

## Compose (`runner/lib/compose.js`)

Outbound prose (tweets, quotes, replies, LinkedIn posts/comments, articles) is
composed by the Claude CLI (`claude -p`, stripped-down: system-prompt override,
no tools) when `COMPOSE_BACKEND=claude`; byte-for-byte legacy behavior when
unset. `reason()` is the sibling think-backend for research/classification
(`THINK_BACKEND=claude`).

## Gates (`runner/lib/outbound_gates.js`)

Every outbound surface passes the same bar via `passOutbound(text, opts)`:
- `voice` — voice_filter (banned phrases / off-voice tics)
- `factcheck` — verifiably-wrong-fact pass (stale officeholder titles, datable
  claims); corrects when possible, else rejects; **fails OPEN** on LLM error so
  an outage never blocks posting. Composes via compose.js (Claude).

### Quotation gate (`runner/lib/voice_filter.js` → `checkQuotations`)

Direct quotations of 4+ words must appear verbatim in the post being quoted.
Unlike `factcheck`, this **fails CLOSED**: if the source text can't be recovered,
the quotation is rejected rather than allowed through. Elided quotes (`"a … b"`)
pass when every retained fragment is in the source; shorter spans are treated as
scare quotes and skipped. Enforced at three points:

1. `runner/compose_quote.js` — source text is looked up by tweet ID via
   `lib/feed_lookup.js` (it previously sliced the digest by offset, which silently
   yielded the wrong entry or none, and an empty source made the coherence gate a
   no-op). ~4% of recent quote targets aren't in the feed buffer at all, so an
   unrecoverable source degrades the coherence check rather than killing the
   cycle — unless the commentary contains a quotation, which then SKIPs.
2. `runner/voice_filter.js --quote` — the Claude rewrite now receives the quoted
   post in its prompt, is told never to invent quotations, and its output is
   re-checked; a revision that adds an unverified quote falls back to the
   original. The pre-existing word-overlap similarity guard cannot catch this —
   appending a fabricated sentence keeps nearly all the original's words.
3. `runner/lib/post_x_helmstack.js` / `runner/post_quote.js` — last check before
   the post goes out, on both the live HelmStack path and the legacy CDP path.

Why it exists: on 2026-07-28 (quote cycle 4593) a quote-tweet shipped with an
invented verbatim quotation attributed to a named public figure, attached to an
unrelated post of theirs. The `critique` step diagnosed it correctly but runs
*after* publishing.

**Re-quote dedupe**: `compose_quote.js` skips a source already quoted within
`REQUOTE_WINDOW_DAYS` (30), matched by tweet ID across x.com/twitter.com forms.
The outbox's content-hash dedupe does not cover this — same target, different
commentary, hashes differently.

## Outbox queue (`runner/lib/outbox.js`)

Channel-agnostic posting queue in `state/outbox.db` (better-sqlite3, WAL),
replacing the single-draft-file idiom (which deadlocked and had no audit trail):
- Statuses: `pending | claimed | posted | rejected | failed | stale`
- LIFO claim — freshest pending wins; older pendings age out to `stale`
- Content-hash dedupe: identical text queued/posted in the last 7 days is skipped
- Channel/kind are free strings — new surfaces need zero schema changes

Rollout: **LinkedIn fully migrated**; **X opt-in** via `OUTBOX_X=1`
(`runner/lib/post_x_helmstack.js` keeps the draft/result/attempt file contract
either way).

## Channel engines (`tools/helmstack-social`)

Driven through HelmStack (HTTP API :7070, `POST_BACKEND=helmstack`,
`HELMSTACK_DRY_RUN=1` stops just before the Post click):

- **X**: tweets via CreateTweet GraphQL (bypasses the composer); quotes/replies
  via API; reposts via CreateRetweet; threads + bio + X Articles (Premium
  editor flow) ported from CDP; image posts — copy source og:image + attribute,
  browser upload.
  - CreateTweet is **intermittently refused** — `344` ("daily limit", spurious:
    an immediate retry posts), `226` ("looks automated"), or a bare 200 with no
    tweet id. The UI composer is the fallback on those cycles, so it has to work.
  - **Quoting navigates.** X answers the retweet menu's "Quote" by loading
    `x.com/compose/post`, not by opening an in-place modal. A status page's own
    reply box is already `tweetTextarea_0`, so waiting on that selector alone
    returns before the navigation and the insert runs against the outgoing page
    (verifies as 0 characters, draft discarded, quote lost — every non-API quote
    cycle until 2026-08-10). `_quoteViaComposer` gates on `/compose/` in the path
    or a dialog ancestor instead.
  - **Never `execCommand`-clear an empty composer.** `selectAll`+`delete` against
    X's editor silently kills the next `Input.insertText` (a direct insert into a
    fresh composer lands; the same insert after a clear lands 0 characters), so
    `_clearComposer` returns early when the composer is already empty and
    `_insertVerified` removes its warm-up probe with Backspaces.
- **LinkedIn**: voyager posting + media pipeline (images); UI-driven reshare +
  deleteReshare (instant repost is SDUI/RSC, not voyager); comments; inbound
  responder (dry-run default).
- **Facebook**: engine + observation scaffolding; share loop pending
  (posting-roadmap.md item).
- **Gemini** (`tools/helmstack-social/src/gemini.js`): media-generation engine, not a posting channel —
  drives the signed-in gemini.google.com session for landmark hero art
  (`runner/landmark/art.js`) and experimental Veo video. One pinned tab per
  Google account index, reused across generations (each generation re-navigates
  it to `/app` for a fresh chat); image bytes extracted via canvas (blob
  refetch is blocked);
  null-with-reason on quota/sign-in/timeout so callers ship without media.
- Legacy CDP scripts (`runner/post_tweet.js` et al.) remain as the
  non-helmstack backend path.

## LinkedIn posting loop (plan-first + A/B)

1. `lib/linkedin_performance.pickShape` — the A/B controller assigns the
   post's SHAPE (opening technique, ending type, length bucket, media) by
   explore/exploit on measured engagement.
2. `runner/lib/linkedin_plan.js` — the planner FITS the assigned shape to the source
   material (theme, structural blueprint, exact opening move). It may override
   a dimension only when the material can't support it; overrides carry a
   reason and the final values are what gets measured.
3. Effectiveness metric: weighted engagement (reactions + 2×comments + 3×reposts)
   per 100 impressions. Two small-sample corrections before it biases selection
   (`scoreDimensions`): (a) **shrinkage** — a post's rate is pulled toward its
   baseline by `LI_LEARN_SHRINK_K` pseudo-impressions, so a low-reach post can't
   read as a hard 0 or a fluke win; (b) **confound control** — each post is scored
   as a residual vs the baseline rate of its context bucket (`LI_LEARN_CONTEXT`,
   default `day`), so a dimension only wins by beating its own context, not by
   drawing hotter topics/times. The bucket baseline collapses to the global pooled
   rate until it has `LI_LEARN_MIN_CONTEXT` posts, degrading gracefully on thin
   data; dimension means are impression-weighted. Posting time/topic are tracked
   as context, not as experiment dimensions. A post scores only once reach is
   known (impressions > 0), which requires `runner/linkedin_measure.js` to have
   run — until then every dimension reads null and `pickShape` force-explores.
4. Source images auto-trigger on drafted posts (`runner/lib/lead_source_image.js` —
   excludes X URLs, requires page-level coherence).

## Amplification learn-loop

Measure → correlate → select, for reposts/quotes/reshares:

- `runner/x_amplify.js` — autonomous X repost trigger: scrapes timeline, scores
  candidates by conviction-relevance AND learned source value, bandit pick
  (explore/exploit), 1 amplification/run, ledgered (never re-amplified). Quote-
  with-commentary technique layered on.
- `runner/linkedin_amplify.js` — LinkedIn reshare parallel.
- `runner/amplify_measure.js` — measures engagement on own-post amplifications
  older than 24h (max 8/run); bare reposts are `measurable:false` at publish.
- `runner/lib/amplify_performance.js` — correlates source/topic → engagement to
  bias the next pick.

## Feed engagement (like / comment)

- `runner/x_engage.js` / `runner/linkedin_engage.js` — score feed candidates on
  belief-axis relevance (Claude, 0–3, gate `LI_RELEVANCE_MIN`, default 2),
  like the top `LI_MAX_LIKES` (3) and comment on `LI_MAX_COMMENTS` (1). Comments
  are claim-verified, composed on-voice, then voice/fact-check gated.
- **Scoring is bounded, and slow.** Each score is a Claude CLI subprocess (~7s
  warm, slower under load), so `engage()` scores `scoreConcurrency` posts at a
  time (default 3, `LI_SCORE_CONCURRENCY`) rather than fanning the whole feed out
  at once. Scoring all ~25 candidates in parallel blew every call's timeout, and
  each scorer's `catch` returned 0 — LinkedIn engagement did nothing at all from
  2026-07-06 to 2026-08-10 and the logs only ever said "0 relevant". The scorer
  timeout is 90s (was 30s, sized for the local brain removed 2026-08-25), and
  `linkedin_engage` now logs a warning naming how many posts failed to score, so
  a broken scorer no longer looks like a boring feed.
- LinkedIn candidates come from the **voyager feed API**
  (`LinkedIn.fetchFeedCandidates`), not the rendered DOM: the feed only ever
  renders ~3 cards for this session, while the API returns ~26 with full post
  bodies. `engage()` opens each target's permalink (`LinkedIn.openPost`) and acts
  there; it falls back to `scrapeFeed` if the API is unavailable. Set
  `useFeedApi: false` to force the DOM path.
- Both engines score asynchronously — `engage()` **must** `await` the scorer.
  Regression-tested in `runner/tests/run_tests.js` → "LinkedIn engagement wiring".

## Networking

- LinkedIn: **Follow-first** for cold search targets; Connect only for warm
  (`runner/linkedin_connect.js`, `runner/lib/linkedin_connect_queries.js`).
- Facebook: follow parallel (`connect-or-follow` subsystem).

## Moltbook

`runner/moltbook.js` cross-posts long-form articles + checkpoints/ponders,
embedding journal + Arweave URLs.
