# helmstack-social

Drive social platforms through a [HelmStack](https://github.com/mondb-dev/helmstack)
browser session. Ships **LinkedIn** posting and feed engagement (like / comment)
today, structured so other platforms slot in the same way.

- **Zero runtime dependencies** — uses the Node 18+ global `fetch`.
- **Proper separation** — the engine knows *how* to drive LinkedIn; it never
  decides *what* to post, *which* posts matter, or *how* to log. Those are
  injected as hooks, so the package has no coupling to any host app.

## How it works (the non-obvious parts)

- **Posting** goes through LinkedIn's own content-creation API via a same-origin
  `fetch` from the logged-in page (CSRF token from the `JSESSIONID` cookie), not
  the share composer — LinkedIn isolates the composer in cross-origin
  anti-automation iframes that UI automation can't reliably drive.
- **Engagement** is DOM automation in the top frame. LinkedIn ships hashed class
  names and no `data-urn`, so posts are found by role/aria-label/text and stamped
  with `data-hs-idx` during a scrape so later actions target them reliably.

## Requirements

- A running **HelmStack** desktop app exposing its agent API on
  `127.0.0.1:7070`, already **logged into LinkedIn** (see *Session setup*).
- Node.js ≥ 18.

## Installation

It's a plain Node package with no dependencies. Use it in place:

```bash
cd tools/helmstack-social
cp .env.example .env          # fill in HELMSTACK_AUTH_TOKEN
npm link                      # optional: exposes the `helmstack-social` CLI globally
```

Or consume it from another package in the same repo:

```json
{ "dependencies": { "helmstack-social": "file:./tools/helmstack-social" } }
```

Or just `require("../tools/helmstack-social/src")` directly (no install step).

Set the connection via environment (or pass `{ url, token }` to the client):

```bash
export HELMSTACK_URL=http://127.0.0.1:7070
export HELMSTACK_AUTH_TOKEN=…            # from HelmStack
```

## Session setup

The package acts on an *already logged-in* LinkedIn session inside HelmStack.
Log in once (manually in the HelmStack window, or transplant cookies from another
browser), then verify:

```bash
# cookies.json = array of {name,value,domain,path?,httpOnly?,secure?,sameSite?,expires?}
# NOTE: expires must be in milliseconds (multiply CDP/puppeteer seconds by 1000)
helmstack-social bootstrap --cookies cookies.json
```

The session persists across HelmStack restarts (persistent browser partition).

## CLI

```bash
helmstack-social health

# Post (long-form is fine; no character cap)
helmstack-social linkedin post --text "Mapping how narratives form in public discourse…"
helmstack-social linkedin post --file draft.txt --dry-run

# Engage: scrape feed, score by keyword overlap, like top matches, optionally comment.
# --comment-command receives the post JSON on stdin and prints the comment (or "SKIP").
helmstack-social linkedin engage \
  --keywords topics.txt --max-likes 3 --max-comments 1 \
  --seen ledger.json \
  --comment-command 'my-llm-comment-generator'
```

## Library API

```js
const { HelmStackClient, LinkedIn } = require("helmstack-social");

const client = new HelmStackClient();                 // env HELMSTACK_URL / _AUTH_TOKEN
const li = new LinkedIn(client, { ownHandleHint: "sebastian hunter" });

await li.ensureTab();
if (!(await li.sessionOk())) throw new Error("not logged in");

// Post
const res = await li.post("Hello LinkedIn");          // → { posted, url }

// Engage — inject scoring, comment generation, and logging
await li.engage({
  score:           (post) => relevanceScore(post.text),      // number, higher = more relevant
  generateComment: async (post) => llm.comment(post),        // string | null
  onLike:          async (post) => db.log("like", post),
  onComment:       async (post, text) => db.log("comment", { post, text }),
  seen:            loadLedger(),                              // Set<string>, mutated in place
  maxLikes: 3, maxComments: 1, minScore: 2,
});
```

### `LinkedIn` methods

| method | description |
| --- | --- |
| `ensureTab()` | Find/open a LinkedIn tab; sets `this.tab`. |
| `sessionOk()` | True if the `li_at` auth cookie is present. |
| `post(text, {dryRun})` | Publish a post → `{posted, url, reason}`. |
| `scrapeFeed({limit})` | Return feed posts `[{idx, author, text, liked, permalink}]`. |
| `like(idx, {dryRun})` | Like a scraped post by index. |
| `comment(idx, text, {dryRun})` | Comment on a scraped post → `{ok, reason}`. |
| `engage(hooks)` | Orchestrate scrape → score → like → comment. |

## HelmStack endpoints used

Standard tabs/navigate/evaluate/cookies/screenshot, plus three CDP input
endpoints (browser-level, so they reach cross-origin iframes):
`POST /api/tabs/:id/insert-text`, `/key`, `/click`.

## Adding a platform

Mirror `src/linkedin.js`: take a `HelmStackClient` in the constructor, expose
`post` / `scrapeFeed` / `like` / `comment` / `engage`, and keep all app-specific
decisions in injected hooks.
