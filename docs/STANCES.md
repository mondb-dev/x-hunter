# Stances

Committed positions on **named, time-bound, contested events** (an impeachment
vote, a World Cup, an election) — distinct from belief axes, which track
open-ended tensions. A stance is an event-scoped mini-axis: a **spectrum
position**, not a binary side.

## Daily scan (`runner/stance_scan.js`)

Invoked daily from the orchestrator, detached (searches + `reason()` calls run
~1–3 min). Non-fatal; gate `STANCE_SCAN_ENABLED != 0`. Two passes over the
stance registry (`lib/stances`):

1. **RESOLVE** — for up to 2 open stances (oldest `last_checked` first), web
   search the event's outcome and adjudicate: resolved (with `was_right` where
   scoreable) or still open. Resolution feeds the belief ontology via
   `lib/stances` → `ontology_delta.json` — being right/wrong is evidence.
2. **FORM** — from the feed digest + current convictions, propose 0–2 NEW
   stances. **Principled** stances must ground in real ontology axes
   (validated by `addStance`); **taste** stances (sports/culture) are capped
   at 2 open at a time.

   The scout reads a compact **candidate menu** (`recentDigestMenu`), not the raw
   digest: `feed_digest.txt` is an append-only ~500KB firehose, so a byte-tail
   skews to whichever RSS batch landed last and hides the named events that are
   real stance material. The menu keeps only header + `TITLE` lines from the last
   ~600 lines (spans many batches/categories), dropping URL/SUMMARY bulk to stay
   token-bounded (~13KB).

Before committing, a stance gets a research + verify pass
(`stance_scan` research step) — no stance on vibes.

## Holding vs. swaying

An open stance holds its line until the event resolves — new evidence does not
silently move it, which is the point (you can be scored on it, and can't quietly
walk it back). But immutability is brittle, so `reviseStance` (`lib/stances`) is
the honest escape hatch, deliberately **costly**:

- Requires a `reason`; capped at `MAX_REVISIONS` (2) per stance — past that,
  resolve or abandon.
- Only `position` / `side` / `confidence_pct` / `rationale` move; identity
  fields (`event`, `question`, `grounded_in`) are immutable.
- Records the full `from → to` history in `revisions[]`.
- A **material** shift (a side flip, or the lean crossing zero) sets
  `needs_public_mind_change` — the reversal must be owned in public, not made
  silently; the flag clears once a `public_post_url` is supplied. (Distinct from
  `post_mind_change.js`, which is axis-driven.)

## Messaging inclusion

`stancesPromptBlock()` injects open stances as a guardrail ("hold these lines;
never contradict in passing") into every composing surface: **tweets**
(`prompts/tweet.js`), **articles** (via `buildConvictions`), **quotes**
(`prompts/quote.js`), and **replies** (`proactive_reply.js`). Consistency across
surfaces is the whole value of a committed stance — a reply that undercuts a
tweeted line is the exact failure this prevents.

## Surfacing

Committed stances render on the website's ontology page
(`web/app/ontology` — "committed stances" section).
