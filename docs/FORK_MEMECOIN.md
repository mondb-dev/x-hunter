# Fork: Memecoin Intelligence Agent

Specialized fork of the Sebastian architecture for memecoin narrative tracking,
historical profiling, and safe-entry timing detection.

---

## Core Thesis

Memecoin outcomes are not random. The on-chain state and narrative shape at any
point post-launch contain enough signal to classify a coin as inside or outside
a historically safe entry window. Sebastian's belief axes + CUSUM drift detection
+ verify pipeline can learn that shape from historical data and apply it in real time.

The agent does not predict *which* coin will run. It answers:
**given this coin's current state, is it inside or outside the historically safe window?**
That is a classification problem, not a prediction — tractable and auditable.

---

## What It Does

### Phase 1 — Historical Profiler (build the pattern library)

- Ingest historical token launches: on-chain tx logs, holder snapshots, price/volume
- Pull parallel narrative timeline: X mentions, Telegram activity, influencer amplification
- Label outcomes: `rug` / `bleed` / `ran` / `sustained`
- Run belief axes over time-series slices (T+15, T+30, T+60, T+120, T+240 min)
- Learn the on-chain + narrative state that preceded each outcome class
- Output: timing probability curve — what the safe window *looked like* historically

**Output artifact:** `profiles/` directory — one JSON per coin with full timeline,
signal states at each checkpoint, outcome label, and annotated entry/exit windows.

### Phase 2 — Live Tracker (apply the pattern library)

- Monitor pump.fun, Dexscreener, Birdeye for new launches in real time
- For each tracked coin: pull on-chain state + narrative state on cadence (see below)
- Score against historical profile library
- Output: scored watchlist with safety window status per coin

### Phase 3 — Timing Profiler (the call)

Per active coin, continuously update:

```
COIN: $TICKER | CA: 0xABC... | AGE: T+47min
ON-CHAIN:
  Liquidity locked: YES (180 days)
  Contract renounced: YES
  Top 10 wallet concentration: 22% (healthy)
  Buy/sell ratio: 1.8 (organic, not bot spike)
  Liquidity depth / mcap: 0.12 (adequate)
NARRATIVE:
  Mention velocity: accelerating (not peaked)
  Community quality: organic replies, low bot ratio
  Influencer stage: early organic (no paid shill pattern detected)
  Telegram: 2,400 members, 340 active (growth rate: +18%/hr)
TIMING WINDOW:
  Status: INSIDE SAFE WINDOW
  Window opened: T+28min (liquidity confirmed + concentration dropped)
  Historical match: 73% of coins with this profile at T+45min ran ≥5x
  Confidence: HIGH
  Watch for: top wallet concentration creeping above 30% = exit signal
```

---

## Belief Axes — Architecture

**Unlike Sebastian, axes are manually seeded, not discovered.**

Sebastian starts from zero because his research question is open-ended — he doesn't
know in advance what he'll find. The memecoin domain is bounded: we already know what
dimensions matter. Pre-seeding means the agent scores on day one, every coin is
comparable against every other, and the historical profiler builds a consistent
pattern library immediately.

**Three-tier structure:**

### Tier 1 — Locked Core Axes
Always scored. Never dropped. Used for all historical comparability.
Changing these breaks the pattern library — treat as immutable once confirmed.

| Axis | Left pole (safe) | Right pole (danger) |
|---|---|---|
| `contract_safety` | renounced, no mint/pause | owner retained, mintable |
| `liquidity_health` | locked ≥90d, adequate depth | unlocked or thin |
| `holder_distribution` | organic spread, top 10 < 28% | whale concentrated, rising |
| `narrative_authenticity` | organic community formation | coordinated shill burst |
| `influencer_stage` | early organic mentions | late paid amplification |
| `trading_pattern` | genuine buy/sell balance 1.2–2.5x | bot/wash or extreme spike |
| `stated_vs_onchain` | project claims match chain reality | claims diverge from data |
| `timeline_risk` | past rug window, momentum building | inside rug window or dead |

### Tier 2 — Extension Axes
Proposed by the agent when it detects a pattern not covered by core axes.
Requires 3+ confirmed instances across separate coins before activation.
Versioned with discovery date — historical profiles before discovery are marked
`pre-[axis_id]` so comparisons remain honest.

Current extensions (none yet — populated as patterns emerge):
```
(empty — will grow from Phase 1 historical analysis)
```

### Tier 3 — Coin-Specific Context
Ephemeral per-coin axes that don't generalize: team identity signals,
chain-specific mechanics, ecosystem context (Solana vs. Base vs. ETH).
Scored per coin, not stored in the global pattern library.

---

### Axis Versioning Rule

When a new rug tactic or shill mechanic is confirmed and formalized into a Tier 2 axis:
- All historical profiles ingested before that date are tagged `pre-[axis_id]`
- The pattern library splits into pre/post cohorts for that axis
- Historical match confidence scores show which cohort they draw from

This keeps the profiler honest — a 73% match rate from pre-discovery data
is not the same as 73% from data where the axis was active.

---

## Safe Timing Signal — What Historical Data Will Teach

Most rugs: within first 10–30 minutes.
Most legitimate runs: narrative and on-chain signals converge between T+25min and T+2hr.

The safe window is not a fixed time range — it is a *state* that can appear at different
times depending on coin velocity. The profiler learns the state, not the clock.

**Composite safe window criteria (to be refined by Phase 1 data):**
- Liquidity locked ≥ 90 days: confirmed
- Contract renounced
- Top 10 wallets: < 28–30% (and declining, not rising)
- Buy/sell ratio: 1.2–2.5 (above 3.0 = bot spike, suspicious)
- Narrative velocity: accelerating but not spiked (CUSUM not in alarm state)
- No coordinated wallet cluster in first 100 buyers
- Influencer mentions: organic first movers only, no paid shill signature

**Exit signal (window closing):**
- Top wallet concentration rising fast
- Sell pressure overtaking buys
- Narrative CUSUM alarm (sudden spike = coordinated shill = dump incoming)
- Dev wallet movement detected

---

## New Modules Required

| Module | Purpose |
|---|---|
| `launch_monitor.js` | polls pump.fun + Dexscreener for new launches, feeds watchlist |
| `onchain_collector.js` | Solscan/Birdeye/Etherscan per-coin state snapshots |
| `wallet_clusterer.js` | groups wallets by funding source, detects coordinated buyers |
| `liquidity_checker.js` | lock status, depth, contract flags |
| `telegram_monitor.js` | Telegram group member count, activity rate, bot ratio |
| `timing_profiler.js` | scores current coin state against historical pattern library |
| `profile_builder.js` | Phase 1 batch job — ingests historical coins, builds pattern library |
| `watchlist_manager.js` | maintains active coin list with TTL, drops dead/rugged coins |
| `alert_emitter.js` | pushes safe window open/close notifications (Telegram bot) |

---

## Stripped From Sebastian Core

- Post pipeline (`post_*.js`) — no public posting
- Persona / vocation / journal website
- Arweave public uploads
- 30-min browse cadence (replaced by coin-specific fast cadence below)

## Kept From Sebastian Core

- Verify pipeline (`verify_claim.js`) — claim vs. on-chain reality checks
- Belief ontology + Bayesian trust-weighted scoring
- CUSUM drift detection — repurposed for narrative velocity and wallet concentration drift
- FTS5 + semantic search — historical pattern matching
- Gemini-2.5-flash via Vertex AI
- Network grapher — wallet relationship mapping

---

## Cadence

### Launch Detection Loop — every 60 seconds
- Poll pump.fun new token feed, Dexscreener `/latest`
- Filter: min liquidity threshold, not already on watchlist
- New tokens that pass filter → add to watchlist, begin tracking

### Active Coin Monitoring Loop — every 2 minutes per tracked coin
- Pull on-chain snapshot: holder count, top wallet %, buy/sell ratio, liquidity depth
- Pull narrative snapshot: X mention count delta, Telegram member/activity delta
- Update belief axes for this coin
- Run timing profiler: is coin inside/outside safe window?
- If window status changes → emit alert

### Narrative Deep Scan — every 10 minutes per tracked coin
- Full X search for CA + ticker: extract quality signals, bot ratio estimate
- Influencer mention detection: check known paid shill accounts
- CUSUM update on mention velocity

### Historical Profiler Batch — runs once on setup, then weekly
- Pull completed coin histories (pump.fun + Dexscreener historical endpoints)
- Label outcomes, extract signal timelines, update pattern library
- Retrain timing score weights against new outcome data

### Watchlist TTL
- Coins stay on watchlist for 24 hours after launch
- Auto-drop if: rugged (liquidity removed), volume dead (<$500/hr), or marked `bleed`
- Graduated cooldown: high-activity coins checked every 2 min → dropping coins every 10 min

---

## Alert Format (Telegram)

```
🟢 SAFE WINDOW OPEN
$TICKER | CA: 0xABC...
Age: T+47min | Conf: HIGH

✅ Liq locked 180d | Renounced
✅ Top 10: 22% (healthy)
✅ Buy/sell: 1.8 (organic)
✅ Narrative: accelerating, not peaked
✅ No coordinated wallets in first 100 buyers

Historical match: 73% of similar profiles ran ≥5x
Watch: top wallet % creeping → exit signal

Dexscreener: https://dexscreener.com/solana/0xABC
```

```
🔴 WINDOW CLOSING — $TICKER
Top wallet % jumped 22% → 34% in 8 min
Dev wallet moved: 0xDEV... → 0xMIX...
Narrative spike (CUSUM alarm) — coordinated shill pattern
```

---

## Commercial Angle

Private tool first — validate the timing profiler accuracy against real outcomes
before any commercial consideration. Track calls vs. results for 60 days minimum.

If accuracy is validated: white-label per trading group / VC / fund.
Charge for access to the live watchlist feed, not per-call advice.
Avoid any framing as financial advice — it is a research classification tool.
