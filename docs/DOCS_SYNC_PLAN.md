# Docs Sync Plan — 2026-07-19

Goal: bring the git docs and the website's descriptive pages back in line with the
system as it actually runs today. Everything below is grounded in the repo state at
`claude/docs-sync-plan-939a98` (HEAD 3aceb2d7) and the live module inventory.

---

## Verified current state (what the docs must say)

| Area | Reality (verified) | What stale docs claim |
|---|---|---|
| Runtime | Local Mac, launchd agents: `com.sebastian.runner`, `com.sebastian.browser`, `com.sebastian.hunter-helmstack`, `com.sebastian.telegram-bot` | GCP VM `us-central1-a`, systemd `sebastian-runner.service`, IAP SSH runbooks |
| Browser | HelmStack substrate (`helmstack-social` package, `runner/lib/helmstack.js`); CDP fully retired in the June migration | Chrome CDP :18801, puppeteer-core (README ×6, ARCHITECTURE ×14, TOOLS ×9 refs) |
| Reasoning LLM | Local `qwen2.5-agent` via Ollama | Gemini 2.5 Flash via Vertex AI (`gemini_agent.js` as the brain) |
| Outbound prose | Claude CLI composes all public text — tweets, quotes, replies, LinkedIn, articles (`runner/lib/compose.js`, `COMPOSE_BACKEND=claude`) | Not mentioned anywhere in git docs (0 hits) |
| Embeddings | `nomic-embed-text` 768-dim, local via Ollama | Gemini `text-embedding-004` via Vertex AI |
| Channels | X + LinkedIn + Facebook + Moltbook; connect/follow networking; amplification learn-loops (`runner/x_amplify.js`, `runner/linkedin_amplify.js`, `runner/amplify_measure.js`) | X-only (LinkedIn/FB: 0 hits in all git docs) |
| Posting path | DB outbox queue (`runner/lib/outbox.js`) + shared outbound gates (`outbound_gates.js`); X posts via CreateTweet GraphQL; LinkedIn migrated to outbox, X behind `OUTBOX_X` flag | Draft files posted by `post_tweet.js`/`post_quote.js` via CDP |
| Research | `runner/deep_research.js`: hierarchical decomposition, triage (bail/reformulate), marks ledger + verify, calibrated publish gate, delivery as report page / X thread / X Article; plan-driven daily research (`runner/plan_research.js`) | Only `docs/deep-research-decomposition.md` (design doc, 7/7) exists |
| Stances | Committed sides on named events, spectrum positions, wired into ontology (`runner/stance_scan.js`, web ontology page section) | Not documented |
| Predictions | Prediction log + resolution + confidence calibration feeding back into generation (`runner/prediction_resolution.js`, `runner/lib/belief_calibration.js`) | Not documented |
| Cost model | LLM meter + operating-cost self-model (`runner/lib/cost_meter.js`, `operating_cost.js`); funding section on About page | Not documented |

Docs freshness: repo history was squashed 2026-06-21; every top-level doc (README,
ARCHITECTURE, TOOLS, AGENTS, HEARTBEAT) and most of `docs/` date from 6/21–6/24.
Only current-ish: `docs/HELMSTACK_MIGRATION.md` (7/5), `docs/deep-research-decomposition.md`
(7/7), `docs/posting-roadmap.md` (7/16).

Website: Next.js in `web/`, Vercel builds from repo on every push, so the site is
never behind git — the drift lives in the page source. `web/app/about/page.tsx`
(updated 7/12) is the *freshest* system description anywhere: it already has
qwen2.5-agent, HelmStack, Claude-composed prose, LinkedIn/FB. Its gaps: no deep
research / published reports, no predictions + calibration, no outbox/amplification,
predates the 7/17 mention-pipeline rework. Other pages (`/predictions`, `/report`,
`/ontology`, `/veritas-lens`) render from data and need no copy changes.

---

## Tasks

Order matters: a full codebase audit first (so docs are written from ground truth,
not from memory of what changed), then git docs (they become the source of truth),
then the About page is rewritten *from* them, then guardrails so this doesn't drift
again.

### Phase 0 — Thorough codebase audit (produces the ground-truth inventory)

- [x] **T0. Build `docs/INVENTORY.md`** — a code-derived snapshot every later task
      cites. Systematic, not sampled:
      1. **Entry points & schedules.** Read every launchd plist (`com.sebastian.*`,
         `ai.openclaw.x-hunter`) → what script each runs, on what cadence. Trace
         `runner/run.sh` → `orchestrator.js` cycle types and modular pipelines
         (`pipelines/main_pipeline.js`, `daily_maintenance.js`); list every timer,
         every N-th-cycle trigger, silent-hours behavior, and every Telegram command
         (`docs/telegram_commands.md` claims vs the bot code).
      2. **Module map.** Every file in `runner/`, `runner/lib/`, `lib/`, `scraper/`,
         `analyzer/`, `workers/*`, `helmstack-social` (find where it lives),
         `tools/`, `scripts/` — one line each: what it does, who calls it, dead or
         alive (no inbound references = flag as dead, don't document it).
      3. **Data & state.** Actual SQLite schema (`scraper/db.js` + any migrations),
         every file referenced under `state/`, Postgres usage in workers, BigQuery
         streaming — confirmed from code, not from the old DATA_COLLECTION list.
      4. **External surfaces.** Every env var actually read (`grep process.env`),
         every outbound endpoint (HelmStack :7070 API calls, X GraphQL ops, LinkedIn
         voyager routes, Cloud Run worker URLs, Arweave/Irys, Vercel hook, Telegram).
      5. **Numeric-claims audit.** Verify each number the docs/website repeat
         (13-phase collect, 14-step pre-browse, 8-gate delta, cadence 15–60 min,
         every-3rd/6th cycle, follow cap 10/day, Jaccard 0.65, drift cap ±0.05,
         confidence ceiling 0.98/0.025-per-source, decay 0.002/day, axis creation
         ≥6×/≥4 accounts/≥2 clusters) against the constants in code; record the
         source file:line for each so future audits are one grep away.
      6. **LLM call sites.** Every place a model is invoked (Ollama/qwen, Claude CLI
         compose, any remaining Gemini/Vertex — incl. `workers/verify` and the
         self-mod builder) with its role, so "who thinks vs who writes" is stated
         precisely everywhere.
      This is fan-out-friendly work (independent read-only sweeps); worth running as
      parallel subagents if done in one sitting.

### Phase 1 — Core git docs (source of truth)

- [x] **T1. Rewrite README.md.** New stack table (launchd, HelmStack, qwen2.5-agent
      brain + Claude compose, outbox, channels), local-Mac deployment + troubleshooting
      (launchctl commands replace all `gcloud compute ssh` runbooks), refreshed project
      structure (add `lib/`, `pipelines/`, `workers/memory`, `helmstack-social`, key
      new runner modules), refreshed "what gets published" (reports, predictions,
      intelligence briefs). Verify every path named actually exists before writing.
- [x] **T2. Consolidate the two ARCHITECTURE.md files.** Root (598 lines) and
      `docs/ARCHITECTURE.md` (327 lines) overlap and are both stale. Keep **root** as
      canonical; fold anything still-true and unique from `docs/ARCHITECTURE.md` in;
      replace `docs/ARCHITECTURE.md` with a one-line pointer. Rewrite the process map
      around: launchd agents → orchestrator → HelmStack; two-layer split is now
      *three* (mechanical / local-qwen reasoning / Claude composition).
- [x] **T3. Regenerate TOOLS.md** from the actual `runner/lib/` + `runner/` + `lib/` +
      `scraper/` inventory (≈50 modules in runner/lib alone; TOOLS.md predates half of
      them and still describes CDP helpers).
- [x] **T4. Redraw docs/SYSTEM_DIAGRAM.md** (mermaid): inputs (X/LinkedIn/FB/RSS via
      HelmStack) → scraper → browse cycle (qwen) → ontology gates → compose (Claude) →
      outbox → channels; side rails for deep research, stances, predictions, amplify,
      cost meter.
- [x] **T5. Update docs/PIPELINE.md + docs/DATA_COLLECTION.md** — cycle sequences,
      state-file list, schedules. Re-verify the numeric claims while there (13-phase
      collect, 14-step pre-browse, 8-gate delta, cadence bounds) against code; these
      numbers are repeated on the website and must match.
- [x] **T6. Update docs/VERIFICATION_PIPELINE.md** — 21 Gemini references; verify
      worker (`workers/verify`) may genuinely still use a cloud model — check the code
      first, then correct only what's wrong.
- [x] **T7. Write the missing subsystem docs** (one file each, short, code-anchored):
      - `docs/DEEP_RESEARCH.md` — full pipeline incl. the 7/17 rework (triage, marks
        ledger, calibrated publish gate, delivery formats); supersede/absorb
        `deep-research-decomposition.md` as the design appendix.
      - `docs/OUTBOUND.md` — outbox queue, outbound gates, channel engines (X GraphQL,
        LinkedIn voyager/UI, FB), image auto-trigger, amplification learn-loops.
      - `docs/STANCES.md` — event-scoped spectrum positions, stance_scan, ontology feedback.
      - `docs/PREDICTIONS.md` — logging, resolution, calibration feedback loop.
      - `docs/COSTS.md` — cost meter, operating-cost self-model, funding surface.
- [x] **T8. Sweep behavioral docs for factual staleness only.** AGENTS.md / SOUL.md /
      IDENTITY.md are *prompt material* for the running agent — do not restructure.
      Fix only wrong facts (Gemini→qwen/Claude, CDP→HelmStack) and confirm each edit
      doesn't change a rule the agent obeys.
- [x] **T9. Archive dead one-offs** to `docs/archive/`: MIGRATION_SQLITE,
      HELMSTACK_MIGRATION (migration is complete), FORK_MEMECOIN, SEBASTIAN_FORKS,
      RESEARCH_IMPROVEMENTS, HELMSTACK feedback remnants; triage BUGS.md (close fixed
      entries). Leave posting-roadmap.md live — it's current.

### Phase 2 — Website

- [x] **T10. Update `web/app/about/page.tsx`** from the finished Phase-1 docs: add
      Deep Research & Reports, Predictions & Calibration, and Posting pipeline
      (outbox → gates → channels, amplification) sections; refresh the mention-reply
      description to the 7/17 pipeline; re-verify every number and section against
      T5's audit. Keep the existing honest-framing sections intact.
- [x] **T11. Sweep remaining site copy** — `layout.tsx` footer/meta, `page.tsx` home,
      `/plan` and `/intelligence` static copy — for stale stack claims (grep for
      Gemini/Vertex/CDP in `web/`).
- [x] **T12. Deploy + verify live.** Merge to main, let the cycle push / Vercel build,
      then load sebastianhunter.fun/about and confirm the new sections render and
      stats populate.

### Phase 3 — Anti-drift guardrails

- [x] **T13. Add a docs-sync rule to the self-modification loop:** any change under
      `runner/`, `scraper/`, `lib/`, or `web/` that alters behavior must touch the
      matching doc in the same commit (mirror how `docs:` commits already accompanied
      the amplify work). Encode it where Hunter's builder reads its conventions.
- [x] **T14. Add a weekly docs-drift audit** to `pipelines/daily_maintenance.js` (or a
      dedicated weekly slot): grep docs for module names that no longer exist + list
      substantive commits since each doc's last touch; file findings to the sprint
      queue rather than auto-editing.

---

## Sizing

T0 is the biggest single task but pays for itself: every doc rewrite becomes
transcription from a verified inventory instead of re-research. T1–T4 are the
high-leverage 80% of the docs work (they're what humans and the agent actually
read). Each Phase-1 task is a single sitting: pull the relevant INVENTORY.md
section, write the doc, cite paths/numbers from it. T7 is five short docs,
parallelizable. Phase 2 depends on Phase 1 finishing (About is written *from* the
docs, not alongside them).
