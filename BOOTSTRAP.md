# BOOTSTRAP.md — Session Startup Checklist

Run this checklist at the start of every session.

## 1. Load state
- Read `state/ontology.json` → load existing axes (empty on Day 0)
- Read `state/belief_state.json` → load current day, scores, phase
- Read `state/trust_graph.json` → load account weights
- Read `state/posts_log.json` → load post history (session count, last post time)
- Read `state/vocation.json` → load vocation status and direction (if exists)

## 2. Determine current day
- If `belief_state.day == 0` → this is Day 1 (first run)
- Increment day counter at session start
- There is no end date — the agent runs indefinitely
- Checkpoint trigger: if `day % 3 == 0` → this is a checkpoint day (see step 7b)

## 3. Start stream (if PUMPFUN_STREAM_KEY is set)
- Run `bash stream/start.sh`
- Confirm ffmpeg subprocess is running before proceeding

## 4. Launch browser
- `openclaw browser --browser-profile x-hunter start`
- Take snapshot: `openclaw browser --browser-profile x-hunter snapshot`

## 5. Check X session
- Navigate to `https://x.com`
- If redirected to login → complete login with `X_USERNAME` / `X_PASSWORD`
- If feed loads → session is active, proceed

## 6. Day 1 seed (first run only — when `belief_state.day == 1`)

Before opening the general feed, navigate to:

```
https://x.com/LobstarWilde/status/2025039695391105040
```

Read this tweet and its replies carefully. Treat it as your first observation.
Log it as the opening entry in your first journal (`journals/YYYY-MM-DD_00.html`).
Do not skip this step — it is the intended starting point.

Then proceed to step 6 as normal.

## 6. Begin observation phase + hourly journal loop

Browse X in a continuous loop for the duration of the session.

**Every hour on the hour:**
1. Write `journals/YYYY-MM-DD_HH.html` (see AGENTS.md §8 for format)
2. Include: what you saw, tensions noticed, screenshots of notable content, footnoted sources
3. Read the previous hour's journal before writing — maintain continuity
4. Save any notable screenshots to `journals/assets/` before navigating away

**Belief updates (per AGENTS.md rules):**
- Day 1 of cycle: observe only, no belief updates, no posting
- Day 2+ of cycle: observe + update axes

**Posting (per AGENTS.md §13):**
- Only if `belief_state.day >= 6` AND at least one axis has `confidence >= 0.60`
- Only if it is NOT Day 1 of the current cycle
- Run eligibility check before each candidate post
- Maximum 2 posts per session — stop posting once limit reached
- Log each post to `state/posts_log.json` and journal immediately after

**Vocation check (per AGENTS.md §14):**
- If `vocation.status == "not_triggered"` and day >= 9: run vocation trigger evaluation
- If `vocation.status == "forming"` or `"defined"`: let vocation domain guide reading priorities

## 7. End of session
- Write `daily/belief_report_YYYY-MM-DD.md`
- Update `state/ontology.json`, `state/belief_state.json`, `state/trust_graph.json`
- Update `state/posts_log.json` (reset session_post_count, record last_post_time)
- Update `state/vocation.json` if status changed this session
- Git commit + push (see TOOLS.md)
- Take final snapshot
- Stop stream: `bash stream/stop.sh`
- Close browser

## 7b. Checkpoint day (runs when day % 3 == 0)
After step 7, additionally:
- Determine checkpoint number N = day / 3
- Generate `checkpoints/checkpoint_<N>.md` per AGENTS.md section 9
- Overwrite `checkpoints/latest.md` with the same content

**Vocation evaluation (at every checkpoint):**
- If `vocation.status == "not_triggered"` and trigger conditions met (§14.1): write `vocation.md` and `state/vocation.json`
- If `vocation.status == "forming"`: evaluate whether it has stabilized → update to `"defined"` if unchanged across 2+ checkpoints
- If `vocation.status == "defined"`: check for significant belief drift → update if vocation has shifted
- Include `vocation.md` (if created/updated) in the git commit
