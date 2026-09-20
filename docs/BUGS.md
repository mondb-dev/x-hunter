# Known Bugs & Fixes

Ongoing log of bugs found, their root cause, and fix status.

> Note (2026-07-19 docs sync): entries below predate the CDP→HelmStack
> migration and the local-LLM/Claude-compose split. Bugs filed against CDP
> posting paths or the Gemini browse agent may no longer be reachable; verify
> against the current stack before acting on any open entry.

---

## Fixed

### Periodic pre-browse steps could never fire (2 months dead)
- **Symptom:** No curiosity directive since 2026-07-05; `cluster_axes` last proposed a merge the same day; no `auto_detected` reading-queue entries; `source_plan.json` reported `cycle_gate:3` every cycle. Nothing logged an error — browse simply ran on the raw X feed.
- **Root cause:** These steps only run on BROWSE cycles, but were gated on `cycle % 12 === 0` (curiosity, search_curiosity, cluster_axes), `cycle % 6 === 0` (deep_dive_detector) and `cycle % 3 === 0` (source_selector). Every multiple of 6 is a TWEET cycle and every `%3` hit is TWEET or QUOTE, so the gates could only ever match a non-BROWSE cycle. Across 1,024 BROWSE cycles from Aug 1 none qualified.
- **Fix:** `dueEvery()` in `runner/lib/pre_browse.js` (cycles since last run, `state/pre_browse_cadence.json`); `source_selector.js` gates on `cycle % 3 === 1`. Regression test asserts the cadence fires on BROWSE cycles.
- **Fixed:** 2026-09-15

### Machine-queued reading was never emitted (~3,200 items)
- **Symptom:** `state/reading_queue.jsonl` held 2,782 `rss_collect`, 398 `source_followup` and 16 `search_curiosity` entries that were never read.
- **Root cause:** `reading_queue.js emitTopItem()` required `from_user` + `added_cycle`; those producers write `source` + `queued_at`. Entries were structurally invisible.
- **Fix:** `pickCandidate()` accepts either shape (12h wall-clock staleness for machine entries), prioritises people's links → agenda entries → rest, and uses time-aware read markers so a re-queued source page can be read again. `source_selector`'s "queue busy" check now ignores stale pending items, which were blocking it permanently.
- **Fixed:** 2026-09-15

### rss_collect hung until the runner killed it
- **Symptom:** ~2 min added to browse cycles; the process outlived its work.
- **Root cause:** the fetch timeout rejected the promise but never destroyed the socket, so the open connection kept the event loop alive until `runScript`'s 120s timeout.
- **Fix:** destroy the request on timeout, `process.exit(0)` after main, per-feed `timeout` override (arXiv's API is slow).
- **Fixed:** 2026-09-16

### Public data export written but never deployed
- **Symptom:** (caught before shipping) `export_public_data.js` writes `web/public/data/**`, but the daily commit adds only `journals/ checkpoints/ state/ articles/ daily/ ponders/`.
- **Root cause:** commit path list in `runner/lib/daily.js` predates anything writing to `web/public/data/`. The orchestrator's cycle commits already included it, so the export would have shipped hours late rather than never.
- **Fix:** added `web/public/data/` to the daily commit paths.
- **Fixed:** 2026-09-16

### Conviction tier collapsed to "lightly" after the agenda pivot
- **Symptom:** (caught before shipping) every draft would post as ≤160 chars, questions only — including posts about a cited, red-teamed solution brief.
- **Root cause:** `voice_filter.js` computes the tier from mean axis confidence and ignores axes below 0.1. The agenda's seeded axes start at 0, so no axis was ever "relevant" and the tier floored.
- **Fix:** under an agenda the tier comes from the draft's grounding (`convictionFromGrounding`): a linked published brief → "strongly", otherwise "moderately", until the agenda axes harden past 0.25.
- **Fixed:** 2026-09-16

### remark-gfm missing from all markdown readers
- **Symptom:** Tables in checkpoints, ponders, articles, reports rendered as raw `| pipe | text |`
- **Root cause:** `remark-html` does not support GFM tables without `remark-gfm` plugin
- **Fix:** Added `remark-gfm` to `readCheckpoints.ts`, `readPonders.ts`, `readReports.ts`, `readArticles.ts`
- **Fixed:** 2026-03-10

---

### generate_checkpoint.js reads belief_state.json for axes count
- **Symptom:** Checkpoint shows "Axes with confidence > 10%: 0" even though ontology has many high-confidence axes
- **Root cause:** `belief_state.json` does not exist — script was reading `(belief?.axes || [])` which returned `[]`
- **Fix:** Changed to read axes from `ontology.json` directly
- **Fixed:** 2026-03-10

---

### Daily report YAML frontmatter bleeds into checkpoint content
- **Symptom:** Checkpoint page shows raw `---\ndate: ...\ntitle: ...\n---` blocks inside "Recent daily reports" section
- **Root cause:** `generate_checkpoint.js` embedded raw daily report content including frontmatter delimiters
- **Fix:** Strip frontmatter with regex before embedding: `raw.replace(/^---[\s\S]*?---\n/, "")`
- **Fixed:** 2026-03-10

---

### post_quote.js "Retweet button not found" — intermittent
- **Symptom:** First attempt to quote-tweet fails with "Retweet button not found"; retry succeeds
- **Root cause:** Fixed 2500ms sleep after `domcontentloaded` not enough for X to render tweet controls
- **Fix:** Replace `sleep(2500)` with `waitForSelector("[data-testid='retweet']", { timeout: 10000 })`
- **Fixed:** 2026-03-10

---

### Checkpoint_3 truncated interpretation + wrong axes count
- **Symptom:** Interpretation ends mid-sentence ("He confidently"), axes count shows 0
- **Root cause:** LLM response was truncated during generation; axes count bug (see above)
- **Fix:** Manually corrected checkpoint_3.md — axes count set to 19, interpretation restored from belief state
- **Fixed:** 2026-03-10

---

### ponder.js tweet doesn't include website URL
- **Symptom:** Ponder declaration tweet has no link to /ponders/N
- **Root cause:** Tweet was written before `ponderCount` was computed
- **Fix:** Moved tweet write to after `ponderCount` is set; appends `https://sebastianhunter.fun/ponders/${ponderCount}`
- **Fixed:** 2026-03-10

---

### ponder.js tweet names only one plan
- **Symptom:** Ponder 1 tweet mentioned "Veritas Lens" only, not both proposed plans
- **Root cause:** Prompt said "what you are going to do first" — LLM naturally picked one
- **Fix:** Changed prompt to "briefly name all proposed actions (one phrase each)"
- **Fixed:** 2026-03-10

---

## Known / Open

### Checkpoint interpretation can be truncated if LLM response cuts off
- **Symptom:** Interpretation section ends mid-sentence
- **Root cause:** Gemini response occasionally truncates; no length validation on output
- **Mitigation needed:** Add length check + retry if interpretation < 100 chars in `generate_checkpoint.js`
- **Status:** Open

---

### posts_log.json entries with empty tweet_url
- **Symptom:** Agent sometimes writes posts_log entries directly (bypassing runner CDP flow), leaving `tweet_url: ""`
- **Root cause:** Agent writing to posts_log via tool call instead of letting runner handle it
- **Mitigation needed:** Runner should own all posts_log writes; agent should only write tweet_draft.txt
- **Status:** Partially mitigated (runner patches tweet_url after post); agent still writes some entries

---
