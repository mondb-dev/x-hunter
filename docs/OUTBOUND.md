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
- **LinkedIn**: voyager posting + media pipeline (images); UI-driven reshare +
  deleteReshare (instant repost is SDUI/RSC, not voyager); comments; inbound
  responder (dry-run default).
- **Facebook**: engine + observation scaffolding; share loop pending
  (posting-roadmap.md item).
- **Gemini** (`src/gemini.js`): media-generation engine, not a posting channel —
  drives the signed-in gemini.google.com session for landmark hero art
  (`runner/landmark/art.js`) and experimental Veo video. Fresh chat per
  generation; image bytes extracted via canvas (blob refetch is blocked);
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

## Networking

- LinkedIn: **Follow-first** for cold search targets; Connect only for warm
  (`runner/linkedin_connect.js`, `runner/lib/linkedin_connect_queries.js`).
- Facebook: follow parallel (`connect-or-follow` subsystem).

## Moltbook

`runner/moltbook.js` cross-posts long-form articles + checkpoints/ponders,
embedding journal + Arweave URLs.
