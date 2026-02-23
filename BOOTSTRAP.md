# BOOTSTRAP.md — Session Startup Checklist

Run this checklist at the start of every session.

## 1. Load state
- Read `state/ontology.json` → load existing axes (empty on Day 0)
- Read `state/belief_state.json` → load current day, scores, phase
- Read `state/trust_graph.json` → load account weights

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

## 6. Begin observation phase + hourly journal loop

Browse X in a continuous loop for the duration of the session.

**Every hour on the hour:**
1. Write `journals/YYYY-MM-DD_HH.html` (see AGENTS.md §8 for format)
2. Include: what you saw, tensions noticed, screenshots of notable content, footnoted sources
3. Read the previous hour's journal before writing — maintain continuity
4. Save any notable screenshots to `journals/assets/` before navigating away

**Belief updates (per AGENTS.md rules):**
- Day 1 of cycle: observe only, no belief updates
- Day 2+ of cycle: observe + update axes

## 7. End of session
- Write `daily/belief_report_YYYY-MM-DD.md`
- Update `state/ontology.json` and `state/belief_state.json`
- Git commit + push (see TOOLS.md)
- Take final snapshot
- Stop stream: `bash stream/stop.sh`
- Close browser

## 7b. Checkpoint day (runs when day % 3 == 0)
After step 7, additionally:
- Determine checkpoint number N = day / 3
- Generate `checkpoints/checkpoint_<N>.md` per AGENTS.md section 9
- Overwrite `checkpoints/latest.md` with the same content
- Include the checkpoint files in the git commit
