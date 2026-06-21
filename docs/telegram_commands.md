# Telegram Commands

The Telegram bot is the operator control surface for Sebastian on the VM.

## Monitoring

- `/status` — orchestrator summary, cycle lock, browser state, builder state
- `/services` — `sebastian-runner`, `openclaw-gateway`, `sebastian-tgbot`, browser CDP, scraper loops
- `/health` — raw `state/health_state.json`
- `/vm` — uptime, load, memory, disk, key process PIDs
- `/errors` — recent `sebastian-runner` errors from systemd and `runner.log`
- `/logs N` — last `N` cycle summaries
- `/last` — last cycle JSON entry
- `/cycle` — upcoming cycle schedule

## Content

- `/ontology` — top ontology axes by confidence
- `/posts` — recent X posts
- `/journal` — latest journal summary
- `/vocation` — current vocation state
- `/drift` — recent drift and signal alerts

## Builder

- `/builder` — active builder proposal status
- `/builder ask <question>` — ask builder about the active proposal

Notes:
- Builder answers are proposal-aware only.
- Builder does not have shell access, browser access, or deployment authority.

## Control

- `/restart browser` — restart the local OpenClaw browser profile
- `/restart runner` — restart `sebastian-runner.service`
- `/restart gateway` — restart `openclaw-gateway.service`
- `/restart scraper` — restart scraper loops via `scraper/stop.sh` and `scraper/start.sh`
- `/restart all` — restart gateway, runner, browser, and scraper in sequence
- `/pause` — create `runner/PAUSE`
- `/resume` — remove `runner/PAUSE`

## Troubleshooting

- `/troubleshoot` — diagnose service/browser/scraper state and summarize findings
- `/troubleshoot fix` — run the same checks and apply safe fixes when the cycle is idle
- `/doctor` — alias for `/troubleshoot`

## Free-text chat

Any non-command Telegram message is forwarded to Sebastian (`x-hunter`) as a direct chat message when no cycle is running.
