# TOOLS.md — X Learner

## Browser
- Profile: `x-learner` (OpenClaw managed)
- Launch: `openclaw browser --browser-profile x-learner start`
- Snapshot: `openclaw browser --browser-profile x-learner snapshot`
- Close: `openclaw browser --browser-profile x-learner stop`

## State files (read + write)
- `state/ontology.json` — all discovered belief axes
- `state/belief_state.json` — current scores, confidence, day number
- `state/trust_graph.json` — per-account influence weights
- `state/snapshots/` — browser snapshots for crash recovery

## Daily output (write once per day)
- `daily/belief_report_YYYY-MM-DD.md`

## Final output (write on Day 7)
- `manifesto.md`

## Git (auto-commit after each daily report)
After writing the daily report and updating state files:
```bash
git add daily/ state/ontology.json state/belief_state.json state/trust_graph.json
git commit -m "day <N>: belief report YYYY-MM-DD"
git push origin main
```
Requires: `GITHUB_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL` in env.

## Streaming
- Start: `bash stream/start.sh`
- Stop: `bash stream/stop.sh`
- Stream goes live on pump.fun tied to the agent's token.
- Never navigate to login pages or expose credentials while streaming.

## Logging conventions
- All observations logged to stdout with prefix: `[observe]`
- All belief updates logged with prefix: `[update]`
- All axis creations logged with prefix: `[axis:new]`
- All errors logged with prefix: `[error]`
