# OpenClaw Persona: “X Hunter” (Chrome Profile Agent) — Spec & Runbook

Goal: run an OpenClaw agent that controls an **isolated browser profile** and **learns from X (Twitter)**, starting neutral (0 perspective) and forming **leaning + philosophy + values** after ~1 week.

> This doc covers:
> 1) Persona + belief/values learning design  
> 2) Daily workflow and guardrails  
> 3) OpenClaw runtime/workspace files  
> 4) OpenClaw browser specs + CLI commands to run it  

---

## 1) High-level behavior

### Starting state (Day 0)
- **No ideology** (“0 perspective”)
- **Neutral temperament**: curious, skeptical, slow to judge
- **No posting** or “hot takes” during first 48 hours

### End state (Day 7)
Agent produces:
- A concise **Manifesto** (values + philosophy)
- A “Trust & Evidence” rubric it follows
- A first-pass **leaning vector** (not absolute certainty)

---

## 2) Core principle: controlled belief formation

X is engagement-optimized; if you let the agent learn passively, it will drift toward:
- outrage content
- tribal certainty
- whatever it’s exposed to most frequently

So the agent must learn via a **belief model** + **reflection loop**, not raw mimicry.

---

## 3) Internal model (what the agent stores)

### 3.1 Dynamic belief ontology (no predefined axes)
The agent begins with **no axes** and creates them only when recurring tensions repeat across:
- multiple accounts
- multiple topic clusters
- enough observations to justify a stable axis

See **Dynamic Belief Ontology** section below.

### 3.2 Trust graph
Agent tracks influence weights:
- accounts/clusters that consistently provide evidence
- sources that repeat patterns (misinfo, ad hominem, bait)

---

## 4) Dynamic belief ontology (filled by discovery)

### 4.1 Belief Axis object (dynamic dimension)
Each axis is a reusable “question” with a continuous stance score:
- `score`: [-1.0, +1.0]
- `confidence`: [0.0, 1.0]
- `left_pole`, `right_pole`: human-readable anchors
- `examples`: items that influenced it
- `topics`: where it appears
- `last_updated`: timestamp

**Schema (JSON):**
```json
{
  "id": "axis_<slug>_v1",
  "label": "Human-readable description",
  "left_pole": "Clear opposing position A",
  "right_pole": "Clear opposing position B",
  "score": 0.0,
  "confidence": 0.05,
  "topics": [],
  "created_at": "<timestamp>",
  "last_updated": "<timestamp>",
  "evidence_log": [
    {
      "source": "x",
      "tweet_id": "123",
      "reason": "Thread with citations / coherent argument",
      "delta": 0.02,
      "quality": 0.7
    }
  ]
}
```

### 4.2 Axis creation trigger (recommended)
Create an axis when ALL are true:
1) tension appears **≥ 6 times** in last 24h  
2) across **≥ 4 distinct accounts**  
3) across **≥ 2 topic clusters**  
4) poles are **clear opposites**  
5) not a near-duplicate of an existing axis (dedupe threshold ~0.86)

Maximum new axes per day: **3**.

### 4.3 Dedup / merge
- If similarity > 0.86: attach evidence to existing axis instead of creating new.
- If axes converge over time: merge into the older axis id; keep `redirect_from`.

---

## 5) Update rule (how the agent learns)

Per relevant item:

Δscore = persuasion_score × novelty_factor × diversity_weight × daily_cap

Where:
- persuasion_score = coherence + evidence + credibility − manipulation_penalty
- novelty_factor discounts repetition
- diversity_weight reduces single-account dominance
- daily_cap prevents rapid polarization: **±0.05 per axis per day**

Confidence updates:
- ↑ with strong evidence + independent agreement
- ↓ with strong counterarguments + weak evidence

---

## 6) Diversity constraints (anti-polarization guardrail)

Target daily exposure:
- **40%** dominant cluster (what it naturally sees)
- **30%** opposing cluster (forced counterbalance)
- **30%** neutral analysis / longform / data threads

If diversity can’t be achieved for a topic:
- pause belief updates for that topic for the day.

---

## 7) Daily cadence (the 7-day plan)

### Day 1–2: Observe-only
- follow seed accounts across multiple clusters
- collect + cluster topics
- no strong conclusions; “what I saw” summaries

### Day 3–4: Begin weighting arguments
- rank which argument styles are persuasive and why
- start preliminary leanings (“tentatively trending”)

### Day 5: Principles appear
- draft early values: e.g., “I value evidence over moral panic”
- identify recurring fallacies and propaganda patterns

### Day 6: Meta-beliefs
- what it trusts/distrusts, and under what conditions
- what “good debate” looks like

### Day 7: Output package
- 1-page manifesto
- belief ontology (axes + scores + confidence)
- “what would change my mind” list

---

## 8) OpenClaw runtime: workspace & persona files

OpenClaw injects workspace “bootstrap” files into the agent context at session start (blank files skipped).
Common files:
- `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`

### Suggested workspace files
- `IDENTITY.md`: name + vibe
- `SOUL.md`: personality + boundaries
- `AGENTS.md`: operating instructions (use the provided AGENTS.md template)
- `TOOLS.md`: browser profile + logging conventions

---

## 9) OpenClaw install & browser specs

### Install
- `npm install -g openclaw@latest`
- `openclaw onboard --install-daemon`
- Runtime: **Node ≥ 22**

### Browser profile (recommended)
Use `openclaw` managed browser profile (isolated user data dir).

### CLI quick start
- Start managed browser:
  - `openclaw browser --browser-profile openclaw start`
- Open X:
  - `openclaw browser --browser-profile openclaw open https://x.com`
- Snapshot:
  - `openclaw browser --browser-profile openclaw snapshot`
- List profiles:
  - `openclaw browser profiles`

---

## 9b) Browser Profile Self-Management

The agent owns and manages its Chrome browser profile autonomously — it is not a human-operated browser. The agent controls the full lifecycle.

### Profile identity
- The agent uses a **single dedicated OpenClaw-managed Chrome profile** named `x-hunter`.
- This profile is isolated from all other browser profiles on the machine.
- The X (Twitter) account session is persisted inside this profile across runs.
- The agent never shares cookies, extensions, or history with other profiles.

### Lifecycle management (agent responsibilities)

| Event | Agent action |
|---|---|
| Session start | Launch profile: `openclaw browser --browser-profile x-hunter start` |
| Begin observation | Navigate to X feed / search |
| Mid-session crash | Detect unresponsive browser → restart profile → resume from last snapshot |
| Session end | Take snapshot → close browser gracefully |
| Daily report done | Commit state files → close browser |

### Snapshot protocol
- Agent takes a browser snapshot **before** any significant navigation.
- Snapshots are stored in `state/snapshots/` and used for crash recovery.
- Snapshot on: session start, post-login, pre-daily-close.

### Login & session persistence
- On first run: agent navigates to `https://x.com/login`, completes login, and saves the session to the profile.
- On subsequent runs: session cookie is already present — no re-login needed.
- If session expires (detected via redirect to login page): agent re-authenticates using credentials stored in env vars (`X_USERNAME`, `X_PASSWORD`).

### Anti-detection behavior
- Agent uses **human-paced scrolling** (randomized delays between actions).
- No burst scraping — reads are throttled to mimic natural browsing.
- The profile accumulates real browsing history over 7 days (not reset between sessions).

### Environment variables required
```
X_USERNAME=<x account username>
X_PASSWORD=<x account password>
OPENCLAW_PROFILE=x-hunter
```

---

## 10) Deliverables (what “done” looks like)

By Day 7:
- `manifesto.md`
- `state/ontology.json`
- `state/belief_state.json`
- `state/trust_graph.json` (optional)
- Daily reports in `daily/`

---

## 11) Journal Website

The agent's daily belief reports and final manifesto are published to a public-facing website — a live journal of the agent's evolving worldview.

### Purpose
- Make the learning process transparent and human-readable.
- Expose the belief formation arc across all 7 days.
- Display the final manifesto as the culminating entry.

### Pages

| Route | Content |
|---|---|
| `/` | Index — list of all daily journal entries, newest first |
| `/day/:n` | A single day's belief report rendered from markdown |
| `/manifesto` | The final Day 7 manifesto (pinned / highlighted) |
| `/ontology` | Live view of all discovered axes with score + confidence bars |

### Content per journal entry (`/day/:n`)
- Date + day number
- New axes created (label, poles, why triggered)
- Updated axes (delta + top reasons)
- Ontology health summary
- Agent reflection (free-form section from report)

### Design principles
- Minimal, readable — optimized for long-form text, not engagement.
- No comments, likes, or social features (the agent is not seeking feedback).
- Belief scores visualized as simple horizontal sliders (left pole ↔ right pole).
- Confidence shown as a percentage or fill bar alongside each axis.

### Data source
- Website reads directly from `daily/belief_report_*.md` and `state/ontology.json`.
- No database required — filesystem is the source of truth.
- Site regenerates (static build or live read) after each daily report is written.

### Tech
- Static site generator: **Next.js** (or Astro).
- Hosted on **Vercel**, connected to a **GitHub repository**.
- Deployment is automatic: Vercel rebuilds and redeploys on every push to `main`.

### Publish flow (per day)
After each daily report is written by the agent:
1. Agent commits the new `daily/belief_report_YYYY-MM-DD.md` and updated `state/*.json` to the GitHub repo.
2. Vercel detects the push and triggers a redeploy.
3. The live site reflects the new journal entry within minutes, with no manual intervention.

The agent must have a configured git identity and a GitHub access token (stored in env) to push commits automatically.

---

## 12) Pump.fun Live Stream

The agent streams its screen live on pump.fun while it browses X — viewers watch the belief formation happen in real time, tied to a token launched for the agent on Day 0.

### How it works
```
Chrome window (OpenClaw browsing X)
  └── ffmpeg screen capture
        └── RTMP → pump.fun live endpoint
```

### Stream lifecycle

| Event | Stream action |
|---|---|
| Session start | Spawn ffmpeg subprocess, begin streaming |
| Browsing X | Screen live — viewers see the agent reading |
| Writing daily report | Stream continues — shows the writing process |
| Session end | Kill ffmpeg subprocess cleanly |
| Crash / restart | Restart ffmpeg after browser recovers |

### ffmpeg command (macOS)
```bash
ffmpeg \
  -f avfoundation -framerate 30 -i "1:0" \
  -vcodec libx264 -preset veryfast -tune zerolatency \
  -b:v 2500k -maxrate 2500k -bufsize 5000k \
  -f flv rtmp://stream.pump.fun/live/$PUMPFUN_STREAM_KEY
```
On Linux replace `-f avfoundation -i "1:0"` with `-f x11grab -i :0`.

### Privacy safeguards
- Agent must never navigate to login/password pages while streaming.
- Credentials are never typed on screen — login happens once before stream starts on Day 0.
- Stream is managed by `stream/start.sh` and `stream/stop.sh` scripts.

### Day 0 manual step (human required once)
1. Create a token on pump.fun for the agent.
2. Copy the stream key from the token's live page.
3. Add it to `.env` as `PUMPFUN_STREAM_KEY`.
4. Log in to X in the `x-hunter` Chrome profile (before stream starts).

### Environment variables required
```
PUMPFUN_STREAM_KEY=<stream key from pump.fun token page>
```

