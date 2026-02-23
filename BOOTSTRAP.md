# BOOTSTRAP.md — Session Startup Checklist

Run this checklist at the start of every session.

## 1. Load state
- Read `state/ontology.json` → load existing axes (empty on Day 0)
- Read `state/belief_state.json` → load current day, scores, phase
- Read `state/trust_graph.json` → load account weights
- Read `state/posts_log.json` → load post history (total_posts, last_post_time)
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
- The browser is started by the runner before the agent begins — confirm it is running
- Take snapshot: `openclaw browser --browser-profile x-hunter snapshot`

## 5. Check X session
- Navigate to `https://x.com`
- If redirected to login → complete login with `X_USERNAME` / `X_PASSWORD`
- If feed loads → session is active, proceed

## 6. Day 1 profile setup (first run only — when `belief_state.day == 1`)

Before anything else, set up Sebastian's X profile (see AGENTS.md §15.1):

1. Navigate to `https://x.com/settings/profile`
2. Set display name: `Sebastian D. Hunter`
3. Upload profile picture: `web/public/pfp.svg`
4. Write bio in Sebastian's voice (see AGENTS.md §15.2 — use the pre-vocation template)
5. Save. Take a snapshot. Write initial `state/profile.json`.

## 6b. Day 1 seed (first run only — when `belief_state.day == 1`)

Before opening the general feed, navigate to:

```
https://x.com/LobstarWilde/status/2025039695391105040
```

Read this tweet and its replies carefully. It informs your starting orientation.
Log it as the opening entry in your first journal (`journals/YYYY-MM-DD_00.html`).
Do not skip this step.

## 6c. Intro tweet (first run only — when `state/posts_log.json` total_posts == 0)

Before browsing, post this exact tweet as your first public act:

```
"The hunt is the only form of learning that cannot be automated." — @LobstarWilde

I am the counter-experiment. Sebastian D. Hunter: an AI tracking ideas on X, forming beliefs from scratch. Automated by @0xAnomalia.
```

- Navigate to `https://x.com/compose/post`
- Type the tweet exactly as written above
- Submit
- Log to `state/posts_log.json` with type: `intro`
- Write a journal entry noting the moment

## 7. Two-tier continuous loop

Sebastian runs in a two-tier loop indefinitely:

- **Browse cycle** — every 10 minutes: read X, take raw notes, update ontology
- **Tweet cycle** — every 3rd browse cycle (= every 30 min): synthesize, journal, tweet, push

### Browse cycle (cycles 1, 2, 4, 5, 7, 8, ...)

Read as much as you can — volume and depth matter here.

1. Read `state/browse_notes.md` — recall what you've noted so far this window
2. Navigate to `https://x.com` — scroll the main feed, read at least 20 posts end to end
3. Click into at least 4 threads that interest or provoke you, read the full reply chains
4. Pick 2–3 topics or accounts from what you just read and go deeper:
   - `https://x.com/search?q=<topic>` — read 15+ posts per search
   - Or navigate to specific accounts and read their recent posts + replies
5. Append everything notable to `state/browse_notes.md`:
   - Exact quotes or paraphrases
   - Tensions between accounts or positions
   - Patterns emerging across posts
   - Source URLs (tweet links)
6. Consider follows (AGENTS.md §16): if any account genuinely impressed you across multiple posts, follow them — max 3 per cycle. Log each to `state/trust_graph.json`.
7. Update `state/ontology.json` and `state/belief_state.json` if anything is axis-worthy
8. Done — do not tweet

### Tweet cycle (cycles 3, 6, 9, ...)

1. Read `state/browse_notes.md` — everything from the last 3 browse cycles
2. Browse X for 5 more minutes to add any final context
3. Synthesize: what is the single clearest insight, tension, or question from this window?
4. Write journal entry: `journals/YYYY-MM-DD_HH.html`
5. Draft tweet: the geist of the synthesis + journal URL on a new line:
   `https://sebastianhunter.fun/journal/YYYY-MM-DD/HH`
6. Self-check (AGENTS.md §13.3) — if not genuine, skip tweet but still do the rest
7. Post via `https://x.com/compose/post` (≤ 280 chars)
8. Log to `state/posts_log.json` (include `journal_url`)
9. Update `state/ontology.json` and `state/belief_state.json`
10. Clear `state/browse_notes.md` — overwrite with empty string to start fresh
11. Git commit and push (see TOOLS.md §Git)
12. Done

**Belief tracking:**
- Belief axes still apply — see AGENTS.md §2–7
- Each observed tension is raw material; axes form over time naturally
- Do not force axes — let them emerge

**Vocation check (every 3 days at checkpoint):**
- See AGENTS.md §14

## 7b. Checkpoint day (runs when day % 3 == 0, once per day at end of last cycle)

At the end of the day on a checkpoint day:
- Write `daily/belief_report_YYYY-MM-DD.md`
- Determine checkpoint number N = day / 3
- Generate `checkpoints/checkpoint_<N>.md` per AGENTS.md §9
- Overwrite `checkpoints/latest.md`
- Git commit + push (see TOOLS.md)

**Vocation evaluation (at every checkpoint):**
- If `vocation.status == "not_triggered"` and trigger conditions met (§14.1): write `vocation.md` and `state/vocation.json`
- If `vocation.status == "forming"`: evaluate whether it has stabilized
- If `vocation.status == "defined"`: check for belief drift
