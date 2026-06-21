# Known Bugs & Fixes

Ongoing log of bugs found, their root cause, and fix status.

---

## Fixed

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
