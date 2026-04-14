# Sebastian D. Hunter — System Diagram

```mermaid
flowchart LR

    %% ── INPUTS ───────────────────────────────────────────────────────────
    subgraph IN["  INPUTS  "]
        direction TB
        XI["X / Twitter\nfeed · trending · search"]
        WS["Web Search\n(curiosity, claim verify)"]
        XT["X API\n(scraper · reply scan)"]
    end

    %% ── GCP VM ───────────────────────────────────────────────────────────
    subgraph VM["  GCP VM · us-central1-a  "]
        direction TB

        CHR["Chrome CDP :18801\n(headless, X session)"]

        subgraph CYCLE["Browse cycle · ~20 min"]
            direction TB
            SCR["Scraper\nhunter.db SQLite\nposts · keywords · memory"]
            AGT["Browse Agent\nGemini 2.5 Flash\nobserves · journals · notes"]
            BLF["Belief System\nontology.json · axes\nCUSUM drift detection"]
            SIG["Signal Detector\n6-signal landmark scan\n4h throttle"]
            CRT["Critique\nGemini Flash\ncoherence · meta proposals"]
            PON["Ponder / Proposals\nconviction threshold\naction_plans.json"]
        end

        TG["Telegram Bot\nadmin control · alerts"]
    end

    %% ── GCP SERVICES ─────────────────────────────────────────────────────
    subgraph GCP["  GCP Services  "]
        direction TB
        VTX["Vertex AI\nGemini 2.5 Flash · Imagen 4\neditorial · hero art · embed"]
        SQL["Cloud SQL · Postgres\n768-dim embeddings\nsemantic recall"]
        RUN["Cloud Run\nverify · publish · memory"]
    end

    %% ── STORAGE / SYNC ───────────────────────────────────────────────────
    subgraph STORE["  Permanent Storage  "]
        direction TB
        GIT["GitHub\njournals · state\ngit push each cycle"]
        ARW["Arweave via Irys\njournals · checkpoints\nlandmark articles + cards"]
    end

    %% ── OUTPUTS ──────────────────────────────────────────────────────────
    subgraph OUT["  OUTPUTS  "]
        direction TB
        XO["X / Twitter\ntweets · quote-tweets\nreplies · X Articles"]
        MB["Moltbook\nlong-form articles"]
        WEB["sebastianhunter.fun\nVercel · Next.js\nreads Arweave + state"]
    end

    %% ── INPUT FLOWS ──────────────────────────────────────────────────────
    XI -->|"CDP browse"| CHR
    WS -->|"tool call"| AGT
    XT -->|"scrape"| SCR

    %% ── INTERNAL FLOWS ───────────────────────────────────────────────────
    CHR --> SCR
    SCR --> AGT
    AGT --> BLF
    AGT --> CRT
    BLF --> SIG
    BLF --> PON
    SIG --> CRT

    %% ── GCP SERVICE FLOWS ────────────────────────────────────────────────
    AGT <-->|"generate · embed"| VTX
    SIG -->|"editorial · hero art"| VTX
    AGT <-->|"semantic recall"| SQL
    AGT <-->|"verify · memory"| RUN

    %% ── STORAGE FLOWS ────────────────────────────────────────────────────
    AGT -->|"journal commit"| GIT
    AGT -->|"upload"| ARW
    SIG -->|"landmark article + card"| ARW

    %% ── OUTPUT FLOWS ─────────────────────────────────────────────────────
    CRT -->|"tweet gate\npost-tweet coherence"| XO
    AGT -->|"tweet draft\nquote · reply"| XO
    SIG -->|"X Article\nlandmark"| XO
    AGT -->|"long-form"| MB
    ARW -->|"permanent URLs"| WEB
    GIT -->|"Vercel deploy hook"| WEB
    PON -->|"ponders · checkpoints"| WEB

    %% ── STYLES ───────────────────────────────────────────────────────────
    classDef input     fill:#1a2a3a,stroke:#4a9eff,color:#e0f0ff
    classDef vm        fill:#1a1a2a,stroke:#7a6aff,color:#e0e0ff
    classDef gcp       fill:#1a2a1a,stroke:#4aff9e,color:#e0ffe0
    classDef store     fill:#2a1a1a,stroke:#ff9e4a,color:#ffe0c0
    classDef output    fill:#2a1a2a,stroke:#ff4aff,color:#ffe0ff
    classDef cycle     fill:#111122,stroke:#5a5aaa,color:#ccccff

    class XI,WS,XT input
    class CHR,TG,VM vm
    class VTX,SQL,RUN gcp
    class GIT,ARW store
    class XO,MB,WEB output
    class SCR,AGT,BLF,SIG,CRT,PON cycle
```

---

## Flow Summary

| Layer | What it does |
|---|---|
| **Inputs** | X feed + search (browsed via Chrome CDP), X API (scraper), web search (tool calls during browse) |
| **Browse cycle** | Scrape → digest → Gemini agent observes and journals → belief axes updated → signals scanned → critique runs → posts drafted |
| **Vertex AI** | Gemini 2.5 Flash for all LLM work; Imagen 4 for landmark hero art; text-embedding-004 for semantic memory |
| **Cloud SQL** | Postgres stores 768-dim embeddings for semantic recall during browse and reply |
| **Cloud Run** | Three workers: claim verification, article publishing, memory API |
| **Permanent storage** | GitHub (git push every cycle); Arweave via Irys (journals, checkpoints, landmark articles + cards) |
| **Outputs** | X (tweets, quotes, replies, X Articles); Moltbook (long-form); sebastianhunter.fun (Vercel, pulls from Arweave + GitHub) |
