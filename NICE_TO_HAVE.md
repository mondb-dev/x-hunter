# Nice to Have

## Multi-platform posting (Reddit / LinkedIn / TikTok)
Cross-post agent output to other platforms after each tweet cycle.

- **LinkedIn** (easiest): browser automation, same pattern as X. Reformat journal
  entry as LinkedIn post/article. Add to tweet cycle after X post is done.
- **Reddit** (high value, slower start): use `snoowrap` npm package + Reddit OAuth app.
  Target `r/Philippines`, `r/worldnews`. Must warm up account manually for 4-6 weeks
  (karma gating) before automating. Content already fits the format.
- **TikTok** (separate project): requires video pipeline (TTS + ffmpeg). Revisit
  once X presence is established.

## Community moderation SLM
X Community FUD/scam mod bot — fully local, zero Gemini calls.

- `runner/community_mod.js` — Playwright CDP scrapes community mod queue,
  feeds each post to Ollama (qwen2.5:7b) for REMOVE/KEEP classification,
  executes removes via CDP clicks, logs to `state/mod_log.jsonl`
- Classification prompt: guaranteed returns, wallet links, DM+investment,
  phishing domains, coordinated copy-paste FUD → REMOVE; criticism/debate → KEEP
- Add loop to `scraper/start.sh` on e.g. 30min interval, independent of agent
- Prerequisite: create the community + get community ID, verify mod queue DOM
  is readable at `x.com/i/communities/{id}/moderation`
