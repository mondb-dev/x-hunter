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

Before committing, a stance gets a research + verify pass
(`stance_scan` research step) — no stance on vibes.

## Surfacing

Committed stances render on the website's ontology page
(`web/app/ontology` — "committed stances" section).
