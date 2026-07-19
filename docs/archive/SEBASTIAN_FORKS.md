# Sebastian Fork Concepts

Potential commercial applications of the Sebastian architecture as directed research agents.
Each fork shares the same core engine — browse, curiosity loop, verify pipeline, belief ontology,
semantic search, network grapher — with a different `research_brief.json` and stripped/added modules.

---

## Core Principle

**Traditional analytics:** gather indiscriminately, analyze after. Answers *what happened*.
**Sebastian approach:** collection shaped by belief axes, verification built into the loop. Answers *what it means and whether it's true*.

The directed approach wins when the research question is known. Broad analytics wins for discovery when the question is unknown. Ideal stack: broad analytics to surface anomalies, Sebastian-class agent to investigate them.

---

## Fork 1 — Political Campaign Research

**Use case:** Opposition research and message framing for campaign strategy.

**What it does:**
- Monitors candidate timeline, mentions, replies, affiliated accounts
- Verifies every public claim the candidate makes
- Detects policy flip-flops via contradiction detector
- Maps donor network and key amplifiers
- Tracks sentiment drift among base vs. swing voters
- Reconstructs narrative arcs around the candidate

**Key axes:**
- `policy_consistency` — flip-flops and position drift
- `donor_network` — funding sources and conflicts
- `voter_sentiment` — base vs. swing voter reception
- `media_narrative` — how press frames the candidate
- `vulnerabilities` — attack surface for opponents

**Stripped:** entire post pipeline, persona/vocation logic, public Arweave
**Added:** `contradiction_detector.js`, `network_mapper.js`, `report_generator.js`

**Output:** contradiction report, sentiment drift, narrative map, vulnerability summary

---

## Fork 2 — Business Intelligence

**Use case:** Competitive intelligence for strategy teams.

**What it does:**
- Monitors competitor accounts, executive statements, PR
- Infers product roadmap from job postings and engineer discussions
- Maps customer pain from public complaints (X, Reddit, G2, Trustpilot)
- Tracks partnership and BD moves
- Detects pricing and positioning shifts
- Catches narrative drift in competitor messaging

**Key axes:**
- `product_roadmap` — feature signals and launch hints
- `hiring_signals` — job postings as strategy indicators
- `customer_sentiment` — public complaints as sales playbook
- `pricing_moves` — positioning shifts
- `partnership_network` — who they are aligning with
- `leadership_signals` — executive direction hints

**Added beyond political fork:**
- `job_board_scraper.js` — LinkedIn/Indeed monitoring
- `review_scraper.js` — G2, Trustpilot, App Store
- `github_monitor.js` — public repo activity and release notes

**Key differentiator:** narrative drift tracker catches when a competitor quietly changes positioning — most businesses miss this because no one watches continuously.

---

## Fork 3 — OSINT (Entity Investigation)

**Use case:** Due diligence, litigation support, corporate security, investigative journalism.

**What it does:**
- Profiles a specific entity (person, org, domain, network) across public sources
- Resolves identity across platforms (entity resolution)
- Maps relationships and network connections
- Reconstructs chronological activity timeline
- Cross-references public claims against verifiable actions
- Produces evidence-chain documented intelligence product

**Key axes:**
- `identity_verification` — confirm identity across sources
- `network_map` — who is this entity connected to
- `timeline` — chronological activity reconstruction
- `stated_vs_actual` — public claims vs. verifiable actions
- `digital_footprint` — all public surface area

**New modules:**
- `entity_resolver.js` — links accounts, emails, names across platforms
- `network_grapher.js` — relationship graph builder
- `timeline_builder.js` — chronological reconstruction
- `source_collector.js` — WHOIS, GitHub, LinkedIn public, business filings, court records, news archives
- `intel_report.js` — structured intelligence product output

**Output format:** confidence-rated findings, sourced evidence, timeline, network map, verified claims, contradictions, gaps

**OPSEC note:** agent must route through residential proxies to avoid tipping off target.

**Differentiator vs. Maltego/SpiderFoot:** those are collection engines. Sebastian adds interpretation — belief axes weight findings, verify pipeline checks claims, contradiction detection flags inconsistencies. Agent produces a conclusion, not a data dump.

---

## Fork 4 — Onchain Investigator

**Use case:** Crypto due diligence, AML compliance, stolen fund recovery, fraud investigation.

**Why this is the strongest fit:** blockchain data is entirely public, self-verifying, immutable, and graph-native. The hard problem is interpretation, not collection — exactly what belief axes do well.

**What it does:**
- Clusters related wallets by funding patterns and behavioral signatures
- Traces fund flows across hops, bridges, mixers
- Links wallet addresses to real-world identities via ENS, X handles, GitHub
- Detects risk signals: mixer use, sanctions proximity, anomalous patterns
- Cross-references project claims against on-chain reality
- Tracks contract ownership, vesting, and known rug signatures
- Follows funds across chains via bridge tracking

**Key axes:**
- `fund_flow` — where did money come from and go
- `entity_clustering` — which wallets belong to same entity
- `risk_signals` — mixer use, sanctions proximity, anomalies
- `identity_linking` — connect wallets to real-world identity
- `stated_vs_onchain` — did project claims match actual behavior

**New modules:**
- `chain_collector.js` — Etherscan/BSCscan/Solscan APIs, The Graph subgraph queries
- `wallet_clusterer.js` — heuristic clustering
- `tx_flow_tracer.js` — recursive fund tracing, flags mixers
- `entity_labeler.js` — matches against known address databases, OFAC sanctions
- `bridge_tracker.js` — cross-chain fund following
- `contract_scanner.js` — bytecode analysis, ownership patterns, rug signatures

**Stated vs. onchain axis examples:**
- "Fully decentralized" → check contract ownership
- "Tokens locked 2 years" → verify vesting contract
- "10,000 active users" → check unique wallet interactions
- "We didn't dump" → trace team wallet outflows

**Commercial buyers:**

| Buyer | Use case | Pay level |
|---|---|---|
| Crypto VCs | Pre-investment team wallet checks | High |
| Exchanges | AML/compliance on listed projects | High |
| Law firms | Stolen fund tracing, fraud litigation | High |
| Recovery firms | Trace and recover stolen assets | High (% of recovery) |
| Investigative journalists | Crypto fraud exposure | Medium |
| DeFi protocols | Whale/exploit monitoring | Medium |

**Differentiator vs. Chainalysis/Arkham/Nansen:** existing tools produce dashboards and graphs. Sebastian produces a narrative intelligence product with confidence levels and sourced conclusions — what lawyers and investigators actually need.

---

## Fork 5 — Brand Narrative Intelligence

**Use case:** PR agencies, corporate communications, brand strategists, investor relations.

**The distinction that matters:**
- Brand monitoring = *what* is being said
- Brand narrative intelligence = *how the story is being told*, by whom, and how it's evolving

**What it does:**
- Tracks dominant narrative frames around the brand (not sentiment — story structure)
- Maps narrative carriers: which voices are authoring the story, weighted by narrative contribution not follower count
- Detects narrative drift before sentiment metrics catch it (reuses CUSUM drift detection from belief ontology)
- Monitors counter-narratives gaining traction
- Identifies gap between stated brand narrative and actual perceived narrative
- Reconstructs how a narrative formed chronologically and what triggered shifts

**Key axes:**
- `dominant_frame` — what story is being told about the brand
- `narrative_carriers` — who is shaping the story and how
- `drift_signal` — how the frame is shifting over time
- `counter_narrative` — competing stories gaining traction
- `stated_vs_perceived` — intended narrative vs. actual reception
- `crisis_formation` — early signals of negative narrative building

**New modules:**
- `narrative_extractor.js` — identifies story frames in content, not just sentiment polarity
- `carrier_mapper.js` — maps narrative contribution by voice
- `drift_alerter.js` — CUSUM on narrative frame shifts (reuses existing belief drift logic)
- `counter_narrative_tracker.js` — monitors competing frames and growth trajectory
- `narrative_report.js` — strategic briefing output

**Sample output:**
```
BRAND: Acme Corp | PERIOD: April → May 2026

DOMINANT FRAME: Shifted from "industry leader" to "out of touch legacy player"
DRIFT STARTED: April 23 — triggered by pricing announcement
PRIMARY CARRIERS: 3 mid-tier journalists + 1 influential customer community
COUNTER-NARRATIVE: "Acme is listening" — brand-led, low traction
STATED VS. PERCEIVED GAP: Brand messaging emphasizes innovation; market is hearing cost-cutting
CRISIS SIGNAL: Narrative consolidating, not fragmenting — intervention window closing
```

**Why existing tools can't do this:** Brandwatch/Talkwalker give sentiment scores and mention volumes. Distinguishing "innovative disruptor" from "corporate sellout" from raw text requires the interpretive layer that LLM-powered belief axes provide. Statistical sentiment tools cannot do it.

**Commercial buyers:**

| Buyer | Use case | Model |
|---|---|---|
| PR agencies | Replace analyst hours, serve brand clients | Per-client monthly retainer |
| Corporate comms | Real-time narrative monitoring | Annual license |
| Brand strategists | Inform messaging and positioning | Project-based |
| Investor relations | How market is framing the company | Subscription |
| Entertainment / IP | Franchise narrative health tracking | Per-property |
| Political campaigns | Candidate narrative management | Campaign cycle |

**Strongest commercial angle:** PR agencies. They sell narrative strategy but produce it through expensive analyst hours. White-label per client, charge agency a monthly fee per client, they mark up to their clients.

---

## Shared Architecture (All Forks)

**Keep from Sebastian core:**
- Browse + curiosity loop (redirected at target/topic)
- Verify pipeline (`verify_claim.js`)
- FTS5 + semantic search (768-dim Gemini embeddings)
- Belief ontology with Bayesian trust-weighted scoring
- CUSUM drift detection
- Network grapher
- Deep dive
- Timeline builder
- Arweave archival (except Brand Intel fork — keep private)
- Gemini-2.5-flash via Vertex AI

**Strip from all forks:**
- Post pipeline (`post_*.js`)
- Persona / vocation forming logic
- Daily tweet cadence in `run.sh`
- Public Arweave uploads (where confidentiality required)

**Shared new addition:**
- `research_brief.json` — defines target, anchored axes, source list, output goals
- Report generator producing structured intelligence product, not journal-style output

---

## Business Model

**White-label SaaS:** same engine, different `research_brief.json` per client. Each client gets their own agent instance. Charge per instance plus report delivery fee.

**The moat:** continuous observation over months detects drift and contradictions that point-in-time searches miss. This is hard to replicate manually.

**Entry point:** PR/reputation monitoring — lowest sales cycle, recurring revenue, agencies already budget for it.
