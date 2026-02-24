# Sebastian D. Hunter — System Architecture

## Overview

An autonomous AI agent that reads X (Twitter), forms beliefs, journals,
tweets, and publishes to sebastianhunter.fun. The system runs continuously
on a Mac with a persistent Chrome session.

There are two distinct layers:

- **Mechanical layer** — Node.js scripts and shell loops that handle all
  scraping, browser navigation, data processing, and side effects. No LLM.
- **Reasoning layer** — Claude (via openclaw) that reads pre-digested text
  files, thinks, and writes text files. No browser access, no shell commands.

> **Current exception**: the tweet cycle still asks the LLM to post to
> x.com and run git commands directly. This is a known gap — the intent is
> to extract those into `runner/post_tweet.js` and have `run.sh` handle git.

---

## Process Map

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                        runner/run.sh                            │
  │                   (main orchestration loop)                     │
  └──────────┬──────────────────────────┬───────────────────────────┘
             │ starts                   │ starts
             ▼                          ▼
  ┌─────────────────────┐    ┌──────────────────────────────────────┐
  │  scraper/start.sh   │    │     Agent cycle (every 20 min)       │
  │  (background loops) │    │  BROWSE (×5) → TWEET (×1) → repeat  │
  └──────────┬──────────┘    └──────────────────────────────────────┘
             │
    ┌────────┼────────────────┐
    ▼        ▼                ▼
collect.js  reply.js     follows.js
(10 min)   (30 min)      (3 hours)
```

---

## Background Loops (Mechanical — No LLM)

### `scraper/collect.js` — every 10 min

Scrapes the X feed via CDP (Playwright connects to existing Chrome on
port 18801). Runs a 12-phase analytics pipeline:

```
CDP extract raw posts
  → sanitizePost()          filter ads, short, emoji-spam, non-English
  → seenSet dedup           skip posts already indexed this session
  → extractKeywords()       RAKE — extract top keyphrases per post
  → base score              velocity (HN-gravity) + trust×0.5 + alignment×0.3
  → deduplicateByJaccard()  remove near-duplicates (keyword Jaccard ≥ 0.65)
  → computeIDF()            corpus IDF over last 4h
  → noveltyBoost()          TF-IDF novelty per post [0–5]
  → re-score                total += novelty × 0.4 → keep top 25
  → fetch replies           top 5 replies for the 8 highest-scoring posts
  → SQLite write            posts table + keywords table + FTS5 index
  → upsertAccount()         rolling per-account stats (avg_score, velocity)
  → clusterPosts()          greedy single-linkage clustering by keyword Jaccard
  → detectBursts()          compare keyword freq vs previous 4h window
  → formatClusteredDigest() write state/feed_digest.txt
```

Output: `state/feed_digest.txt`, `state/index.db`

---

### `scraper/reply.js` — every 30 min

Processes `state/reply_queue.jsonl` (FIFO, oldest-first). For each pending
mention:

```
1. Spam pre-filter          algorithmic regex — no API call wasted
2. fetchThreadContext()     CDP navigates to tweet URL, extracts ≤6 articles
                            (ancestor tweets + the mention itself)
                            → page stays on tweet URL for step 5
3. recallForMention()       RAKE keywords from mention text
                            → db.recallMemory() → ≤3 relevant past entries
                            from journals/checkpoints (FTS5 BM25)
4. geminiClassify()         Gemini 2.0 Flash with full context:
                              - Thread context
                              - Past thinking from memory
                              - The mention text
                            Returns WORTHY+reply or SKIP+reason
5. postReply()              CDP posts reply (page already on tweet URL —
                            no re-navigation)
6. logInteraction()         state/interactions.json (records memory_used)
```

Rate limits: 3/run · 5 min between posts · 10/day cap

---

### `scraper/follows.js` — every 3 hours

Data-driven follow module. Scores accounts from the `accounts` table:

```
follow_score = avg_velocity × 0.35
             + avg_score    × 0.30
             + topic_affinity × 0.25   (keyword overlap with ontology axes)
             + recency_factor × 0.10   (10 × exp(-ageHours/48))

→ followCandidates()     top unfollow'd accounts above threshold
→ CDP follow action      navigate x.com/<username>, click Follow
→ markFollowed()         accounts.followed = 1
→ trust_graph.json       logged with trust_score:3, follow_reason
```

Rate limits: 3/run · 1 min between follows · 10/day cap

---

## Agent Cycle (Reasoning — LLM Only)

Runs every 20 minutes. Every 6th cycle is a tweet cycle (every 2 hours).

### Before each browse cycle — `run.sh` prepares context:

```bash
node scraper/query.js --hours 4     → state/topic_summary.txt
node runner/recall.js --limit 5     → state/memory_recall.txt
```

### Browse cycle (×5 of every 6)

LLM reads pre-digested files, thinks, writes notes. No browser.

```
Reads:
  state/browse_notes.md        prior notes from this window
  state/topic_summary.txt      top keywords + topic clusters (last 4h)
  state/feed_digest.txt        scored clustered digest

Digest format:
  CLUSTER N · "label" · M posts [· ★ TRENDING]
    @user [vSCORE TTRUST NNOVELTY] "text" [engagement] {keywords}
    > @reply: "reply text"
  SINGLETONS · M posts

  v = HN-gravity velocity
  T = trust score 0–10 (from trust_graph.json)
  N = TF-IDF novelty 0–5 (5 = rarest topic this window)
  ★ TRENDING = keyword frequency >2× vs previous 4h window
  ← novel = singleton with N ≥ 4.0

Writes:
  state/browse_notes.md        appends tensions, quotes, patterns
  state/ontology.json          update if axis-worthy
  state/belief_state.json      update beliefs
```

### Tweet cycle (every 6th = every 2 hours)

```
Reads:
  state/browse_notes.md        all notes from the last 5 browse cycles
  state/feed_digest.txt        latest digest for final context
  state/memory_recall.txt      relevant past journal/checkpoint excerpts
                               (ask: have I said this before? has my view evolved?)

Writes:
  journals/YYYY-MM-DD_HH.html  journal entry for this synthesis window
  state/posts_log.json         log the tweet
  state/ontology.json          update
  state/belief_state.json      update

Then (still LLM — targeted for extraction):
  → posts tweet via x.com/compose/post
  → git add / commit / push

After LLM returns — run.sh:
  node runner/archive.js       index new journals/checkpoints → SQLite memory
                               → attempt Irys/Arweave upload if SOL balance ok
```

---

## Memory System

Two-tier: Arweave = permanent truth store, SQLite = fast local recall index.

```
journals/YYYY-MM-DD_HH.html
checkpoints/checkpoint_N.md          source files
daily/belief_report_YYYY-MM-DD.md
         │
         ▼
runner/archive.js
  stripHtml() / read markdown
  extractKeywords() RAKE
  db.insertMemory()            → state/index.db  memory table + memory_fts FTS5
  irys.upload()                → Arweave (permanent, funded by SOL)
  state/arweave_log.json       → TX ID record (git-tracked)
         │
         ▼
runner/recall.js --query "terms"
  db.recallMemory()            FTS5 BM25 search over text_content + keywords
  → state/memory_recall.txt    formatted excerpts for agent context
```

`arweave_log.json` is committed to git. It's the rebuild record — if the
local SQLite index is lost, the TX IDs in this file let you re-fetch every
uploaded file from `https://arweave.net/<tx_id>`.

---

## State Files

| File | Written by | Read by | Gitignored |
|---|---|---|---|
| `state/feed_digest.txt` | collect.js | LLM browse | yes |
| `state/feed_buffer.jsonl` | collect.js | collect.js | yes |
| `state/topic_summary.txt` | query.js | LLM browse | yes |
| `state/memory_recall.txt` | recall.js | LLM tweet | yes |
| `state/browse_notes.md` | LLM browse | LLM tweet | no |
| `state/index.db` | collect.js, archive.js | reply.js, recall.js, query.js | yes |
| `state/reply_queue.jsonl` | collect.js | reply.js | yes |
| `state/follow_queue.jsonl` | follows.js | follows.js | yes |
| `state/interactions.json` | reply.js | — | no |
| `state/trust_graph.json` | follows.js, LLM | collect.js (trust score) | no |
| `state/arweave_log.json` | archive.js | — | **no** (git-tracked) |
| `state/ontology.json` | LLM | collect.js (scoring) | no |
| `state/belief_state.json` | LLM | LLM | no |
| `state/posts_log.json` | LLM | — | no |

---

## Data Flow (End-to-End)

```
X feed (raw HTML)
    │
    ▼ CDP (Playwright)
collect.js — 12-phase pipeline — scored + clustered digest
    │                                │
    ▼                                ▼
state/index.db               state/feed_digest.txt
(posts, keywords,                    │
 accounts, memory,                   ▼
 memory_fts)             query.js → topic_summary.txt
    │                                │
    │   recall.js ←──────────────────┘
    │       │
    │       ▼
    │   memory_recall.txt
    │
    ├── reply.js → fetchThreadContext (CDP) → geminiClassify → postReply (CDP)
    │
    └── follows.js → computeFollowScore → CDP follow → trust_graph.json
                                               │
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                     LLM browse agent                   LLM tweet agent
                     (reads digest +                    (reads notes +
                      topic summary +                    digest + memory)
                      memory recall)                           │
                             │                                 ▼
                             ▼                      journals/YYYY-MM-DD_HH.html
                    state/browse_notes.md            tweet → x.com
                    state/ontology.json              git push
                    state/belief_state.json               │
                                                          ▼
                                                   archive.js
                                                   (index + Arweave upload)
```

---

## Key Algorithms

### HN-Gravity velocity score
```
velocity = likes / (age_hours + 2)^1.5
```
Decays engagement weight over time. A 1-hour-old post with 100 likes
scores higher than a 24-hour-old post with the same likes.

### RAKE keyword extraction
Splits text on stop words. Scores phrases by `(degree + freq) / freq`
where degree = co-occurrence with other words in the same phrase.
Top N phrases become the post's keyword tags.

### TF-IDF novelty boost
`IDF = log((N+1) / (df+1))` across the 4h corpus.
Post novelty = mean IDF of its keywords, capped at 5.0.
High novelty = rare topic this window. Low = commonly recurring.

### Jaccard deduplication / clustering
`similarity = |A ∩ B| / |A ∪ B|` on keyword sets.
- Dedup threshold: ≥ 0.65 (same story, different accounts)
- Cluster threshold: ≥ 0.25 (related topic, same conversation)

### Burst detection
A keyword bursts if `currentFreq ≥ 2 AND currentFreq > prevFreq × 2.0`
comparing current 4h window vs previous 4h window.

### Follow score
```
follow_score = avg_velocity × 0.35
             + avg_score    × 0.30
             + topic_affinity × 0.25
             + recency_factor × 0.10
```
`topic_affinity` = proportion of account keywords matching ontology axis labels × 10.
`recency_factor` = `10 × exp(-ageHours / 48)`.

---

## Technology Stack

| Component | Technology |
|---|---|
| Browser automation | Playwright CDP (connects to existing Chrome, port 18801) |
| Database | SQLite via `better-sqlite3` — WAL mode, FTS5 full-text search |
| LLM (browse + tweet) | Claude Sonnet via `openclaw agent` |
| LLM (reply filter) | Gemini 2.0 Flash via REST API |
| Permanent storage | Arweave via Irys L2 (SOL-funded, `@irys/sdk`) |
| Web frontend | Next.js at sebastianhunter.fun |
| Orchestration | Bash (`run.sh`, `start.sh`, `stop.sh`) |

---

## Known Gap: LLM Navigation

The tweet cycle currently instructs the LLM to:
1. Navigate to `x.com/compose/post` and post the tweet
2. Run `git add / commit / push`

These are mechanical actions and should be extracted:
- `runner/post_tweet.js` — reads `state/tweet_draft.txt`, posts via CDP
- `run.sh` handles git after the agent returns

Until then, the LLM uses browser tools for posting and bash for git.
The browse agent has no browser navigation responsibilities.
