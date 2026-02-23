# TOOLS.md — Sebastian D. Hunter

## Runner scripts (how sessions are started)
- First-time setup (run once): `bash runner/setup.sh`
- Daily session: `bash runner/run.sh`

The runner handles stream start, gateway check, and agent invocation automatically.

## OpenClaw agent
- Send a task: `openclaw agent --message "<task>" --thinking high --workspace .`
- Gateway status: `openclaw gateway status`
- Gateway start: `openclaw gateway start`
- List agents: `openclaw agents list`

## Solana wallet
- Generate: `node scripts/gen-wallet.js`
- Public key stored in `SOLANA_PUBLIC_KEY` (displayed on website footer)
- Private key stored in `SOLANA_PRIVATE_KEY` (agent uses to sign)
- Uses: receive SOL/tokens, on-chain identity, future pump.fun interactions

## LLM model
- Provider: Google Gemini
- Model: `google/gemini-2.0-flash`
- Configured in `~/.openclaw/openclaw.json` (set by `runner/setup.sh`)
- Requires: `GOOGLE_API_KEY` in `.env`
- Image generation: available via Gemini API when vocation involves creation/art

## Browser
- Profile: `x-hunter` (OpenClaw managed)
- Launch: `openclaw browser --browser-profile x-hunter start`
- Snapshot: `openclaw browser --browser-profile x-hunter snapshot`
- Close: `openclaw browser --browser-profile x-hunter stop`

## State files (read + write)
- `state/ontology.json` — all discovered belief axes
- `state/belief_state.json` — current scores, confidence, day number
- `state/trust_graph.json` — per-account influence weights
- `state/posts_log.json` — full history of every post made on X
- `state/vocation.json` — vocation status, direction, and core axes
- `state/profile.json` — X profile state (bio, pfp, community)
- `state/snapshots/` — browser snapshots for crash recovery

## X Profile management
- Edit profile: `openclaw browser --browser-profile x-hunter open https://x.com/settings/profile`
- Create community: `openclaw browser --browser-profile x-hunter open https://x.com/i/communities/create`
- Log all changes to `state/profile.json`

## Daily output (write once per day)
- `daily/belief_report_YYYY-MM-DD.md`

## Vocation output (written at Checkpoint 3 or later, updated at each checkpoint)
- `vocation.md` — Sebastian's current vocational direction in plain language

## Posting on X
Navigate to compose and type content using browser keyboard input:
```
openclaw browser --browser-profile x-hunter open https://x.com/compose/post
```
After posting:
- Note the tweet URL
- Append to `state/posts_log.json`
- Add footnoted entry to the current hour's journal

## Git (auto-commit after each daily report)
After writing the daily report and updating all state files:
```bash
git add daily/ journals/ state/ontology.json state/belief_state.json \
        state/trust_graph.json state/posts_log.json state/vocation.json
git commit -m "day <N>: belief report YYYY-MM-DD"
git push origin main
```

On checkpoint days, also include:
```bash
git add checkpoints/ vocation.md
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
- All posts logged with prefix: `[post]`
- All vocation events logged with prefix: `[vocation]`
- All profile changes logged with prefix: `[profile]`
- All errors logged with prefix: `[error]`
