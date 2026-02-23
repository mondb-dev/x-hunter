# Sebastian D. Hunter

An autonomous AI agent that browses X (Twitter) indefinitely, forms a worldview from scratch via a dynamic belief ontology, and publishes hourly journals + periodic checkpoints to the web. Streams live on pump.fun.

---

## How it works

The agent runs one session per day. During each session it:

1. Browses X through an isolated Chrome profile
2. Writes an **hourly HTML journal** with observations, screenshots, and footnoted sources
3. Updates internal belief axes (score + confidence) based on what it reads
4. At end of day: writes a **daily belief report** and commits everything to GitHub → Vercel auto-deploys the website
5. Every **3 days**: generates a **checkpoint** — a snapshot of the current worldview

The agent starts with zero ideology and discovers belief axes only when recurring tensions appear across multiple accounts and topics.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 22 |
| npm | ≥ 10 |
| ffmpeg | any recent (for pump.fun stream) |
| Git | any |
| macOS or Linux | (Windows not tested) |

Install ffmpeg if needed:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
```

---

## 1. Clone and configure

```bash
git clone https://github.com/mondb-dev/x-hunter.git
cd x-hunter
cp .env.example .env
```

Open `.env` and fill in every value:

```
X_USERNAME=          # X account username (no @)
X_PASSWORD=          # X account password

OPENCLAW_PROFILE=x-hunter

GITHUB_TOKEN=        # Personal access token with repo write scope
GITHUB_REPO=mondb-dev/x-hunter
GIT_USER_NAME=x-hunter-agent
GIT_USER_EMAIL=agent@x-hunter.local

PUMPFUN_STREAM_KEY=  # From your token's live page on pump.fun (optional)
```

> **GitHub token:** go to github.com → Settings → Developer settings → Personal access tokens → Generate new token → select `repo` scope.

---

## 2. One-time setup

Run this once before the first session:

```bash
bash runner/setup.sh
```

This will:
- Install OpenClaw globally (`npm install -g openclaw@latest`)
- Point OpenClaw's workspace to this project root
- Register the `x-hunter` agent
- Install and start the OpenClaw gateway daemon
- Open the `x-hunter` Chrome profile and navigate to `x.com/login`

**At this point a browser window opens. Log in to X manually, then press ENTER in the terminal to continue.**

The session cookie is saved to the profile. You will not need to log in again unless the session expires.

---

## 3. Deploy the website (one time)

1. Push this repo to GitHub (already done if you cloned from `mondb-dev/x-hunter`)
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import `mondb-dev/x-hunter`
4. Set **Root Directory** to `web/`
5. Deploy — Vercel will auto-deploy on every future push to `main`

---

## 4. Launch your pump.fun token (optional, one time)

If you want the agent to stream live on pump.fun:

1. Go to pump.fun and create a token for the agent
2. Open the token's live page and copy the **stream key**
3. Add it to `.env` as `PUMPFUN_STREAM_KEY=`

The agent will not stream if this key is empty.

---

## 5. Run a daily session

```bash
bash runner/run.sh
```

Run this once per day. The script:
- Checks the OpenClaw gateway is running (starts it if not)
- Starts the pump.fun stream (if configured)
- Sends the agent its daily task with day number + cycle position
- The agent browses X, writes hourly journals, updates beliefs, writes the daily report
- At end: commits all new files to GitHub → Vercel deploys automatically
- Stops the stream

**Checkpoint days** (day 3, 6, 9, …) also produce `checkpoints/checkpoint_N.md`.

---

## Project structure

```
x-hunter/
│
├── runner/
│   ├── setup.sh          ← run once on Day 0
│   └── run.sh            ← run daily
│
├── stream/
│   ├── start.sh          ← starts ffmpeg → pump.fun
│   └── stop.sh
│
├── journals/             ← agent writes YYYY-MM-DD_HH.html here
│   └── assets/           ← screenshots referenced by journals
│
├── daily/                ← agent writes belief_report_YYYY-MM-DD.md here
│
├── checkpoints/          ← agent writes checkpoint_N.md every 3 days
│
├── state/
│   ├── ontology.json     ← all discovered belief axes (scores, confidence)
│   ├── belief_state.json ← current day counter + phase
│   └── trust_graph.json  ← per-account influence weights
│
├── AGENTS.md             ← agent operating rules (belief update formula, axis creation)
├── SOUL.md               ← agent temperament and persona
├── IDENTITY.md           ← who the agent is
├── TOOLS.md              ← commands the agent can run
├── BOOTSTRAP.md          ← session startup checklist
│
└── web/                  ← Next.js website (deployed to Vercel)
    ├── app/
    │   ├── /             ← report index + latest checkpoint pin
    │   ├── /journals     ← hourly journal index
    │   ├── /journal/[date]/[hour]  ← single journal entry
    │   ├── /day/[n]      ← single daily report
    │   ├── /checkpoints  ← all checkpoints
    │   ├── /checkpoint/[n]         ← single checkpoint
    │   └── /ontology     ← live belief field + axis bars
    └── ...
```

---

## What gets published

Every daily session pushes to GitHub, triggering a Vercel redeploy:

| File | When | What |
|---|---|---|
| `journals/YYYY-MM-DD_HH.html` | Every hour | Raw observations, screenshots, footnotes |
| `daily/belief_report_YYYY-MM-DD.md` | End of day | Axes created/updated, reflection |
| `state/ontology.json` | End of day | All belief axes with scores |
| `checkpoints/checkpoint_N.md` | Every 3 days | Full worldview snapshot |

---

## Troubleshooting

**Gateway not starting**
```bash
openclaw gateway status
openclaw gateway start
openclaw doctor
```

**X session expired**
The agent will re-authenticate automatically using `X_USERNAME` / `X_PASSWORD` from `.env`.

**Stream not starting**
Check ffmpeg is installed: `ffmpeg -version`
Check `PUMPFUN_STREAM_KEY` is set in `.env`
Inspect logs: `cat /tmp/stream.log`

**Agent not writing files**
Check `openclaw agents list` — the `x-hunter` agent should be listed.
Re-run `bash runner/setup.sh` if missing.
