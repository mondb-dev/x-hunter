# Sebastian D. Hunter — System Diagram

```mermaid
flowchart LR

    %% ── INPUTS ───────────────────────────────────────────────────────────
    subgraph IN["  INPUTS  "]
        direction TB
        XI["X feed · trending\nsearch · mentions"]
        LI["LinkedIn feed"]
        FB["Facebook + RSS\n(GMA · PCIJ · …)"]
        WS["Web search\n(curiosity · research · verify)"]
    end

    %% ── LOCAL MAC (launchd) ─────────────────────────────────────────────
    subgraph MAC["  Local macOS · launchd  "]
        direction TB

        HS["HelmStack substrate\nHTTP API :7070\n+ helmstack-social engines"]

        subgraph CYCLE["Browse cycle · 15–60 min (cadence)"]
            direction TB
            SCR["Scraper\nstate/index.db SQLite\nposts · keywords · memory"]
            AGT["Browse agent\nqwen2.5-agent (Ollama)\nobserves · journals · delta"]
            BLF["Belief system\nontology.json · axes\ngates + calibration"]
            CUR["Curiosity / discourse\n/ trending direction"]
        end

        subgraph RSRCH["Research & positions"]
            direction TB
            DR["Deep research\ntriage→plan→execute\n→refine→resolve→synth"]
            ST["Stances\nnamed-event positions"]
            PR["Predictions\nlog · resolve · calibrate"]
        end

        subgraph OUTB["Outbound"]
            direction TB
            CMP["Compose\nClaude CLI"]
            GTE["Outbound gates\nvoice + fact-check"]
            OBX["Outbox queue\nstate/outbox.db"]
            AMP["Amplify learn-loop\nrepost/reshare bandit"]
        end

        CST["Cost self-model\nLLM meter + fixed + SOL"]
        TG["Telegram bot\nadmin · /dr research"]
    end

    %% ── CLOUD ────────────────────────────────────────────────────────────
    subgraph CLOUD["  Cloud  "]
        direction TB
        RUN["Cloud Run workers\nverify (Gemini) · publish · memory"]
    end

    %% ── STORAGE ──────────────────────────────────────────────────────────
    subgraph STORE["  Permanent Storage  "]
        direction TB
        GIT["GitHub\ngit push each cycle"]
        ARW["Arweave via Irys\njournals · checkpoints\narticles · evidence URLs"]
        PA["Posts archive\nstate/posts_archive/\nappend-only · never pruned"]
    end

    %% ── OUTPUTS ──────────────────────────────────────────────────────────
    subgraph OUT["  OUTPUTS  "]
        direction TB
        XO["X\ntweets · quotes · replies\nthreads · X Articles"]
        LO["LinkedIn\nposts · comments · reshares"]
        MB["Moltbook\nlong-form articles"]
        WEB["sebastianhunter.fun\nVercel · Next.js\nreports · ontology · predictions"]
    end

    %% ── FLOWS ────────────────────────────────────────────────────────────
    XI --> HS
    LI --> HS
    FB --> HS
    HS --> SCR
    WS --> DR
    WS --> AGT

    SCR --> AGT
    AGT --> BLF
    BLF --> CUR
    CUR --> AGT
    ST <--> BLF
    PR <--> BLF
    SCR -->|"mentions\n(research intent)"| DR
    TG -->|"/dr"| DR

    AGT --> CMP
    DR --> CMP
    CMP --> GTE
    GTE --> OBX
    OBX --> HS
    AMP --> HS
    HS --> XO
    HS --> LO

    SCR -->|"append"| PA
    BLF <-->|"claim verify"| RUN
    AGT -->|"commit"| GIT
    AGT -->|"upload"| ARW
    CMP --> MB
    GIT -->|"Vercel build"| WEB
    ARW -->|"permanent URLs"| WEB
    CST -.-> WEB

    %% ── STYLES ───────────────────────────────────────────────────────────
    classDef input  fill:#1a2a3a,stroke:#4a9eff,color:#e0f0ff
    classDef mac    fill:#1a1a2a,stroke:#7a6aff,color:#e0e0ff
    classDef cloud  fill:#1a2a1a,stroke:#4aff9e,color:#e0ffe0
    classDef store  fill:#2a1a1a,stroke:#ff9e4a,color:#ffe0c0
    classDef output fill:#2a1a2a,stroke:#ff4aff,color:#ffe0ff

    class XI,LI,FB,WS input
    class HS,SCR,AGT,BLF,CUR,DR,ST,PR,CMP,GTE,OBX,AMP,CST,TG mac
    class RUN cloud
    class GIT,ARW,PA store
    class XO,LO,MB,WEB output
```

---

## Flow Summary

| Layer | What it does |
|---|---|
| **Inputs** | X + LinkedIn + Facebook/RSS feeds via HelmStack; web search (curiosity, deep research, claim verification) |
| **Scraper** | Sanitize → RAKE → Jaccard dedup → TF-IDF novelty → local-LLM enrichment → cluster + burst detection → scored digest → SQLite + permanent local posts archive |
| **Browse cycle** | 17-step pre-browse → local qwen2.5-agent reads digest + memory → journals + ontology delta → evidence gates (`apply_ontology_delta.js`) → axes updated via `belief_calibration.js` |
| **Research** | Deep research (mentions, Telegram `/dr`, daily plan questions) → reports / X threads / X Articles; stances + predictions feed back into the ontology |
| **Outbound** | Claude composes → voice + fact-check gates → outbox queue → HelmStack channel engines (X GraphQL, LinkedIn voyager/UI); amplification learn-loop reposts/reshares and measures results |
| **Cloud** | Cloud Run workers (verify — Gemini, publish, memory) |
| **Permanent storage** | GitHub (push every cycle); Arweave via Irys (journals, checkpoints, articles, evidence source URLs) |
| **Outputs** | X, LinkedIn, Facebook (observation + planned share), Moltbook, sebastianhunter.fun (journals, ontology, reports, predictions, veritas lens, checkpoints) |
