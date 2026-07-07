# Deep Research: Hierarchical Decomposition Engine — Design

**Status:** proposed · **Owner:** Sebastian Hunter · **Component:** `runner/deep_research.js`

## Goal

Turn deep research from a flat *plan → execute → refine → synthesize* pass into a
**hierarchical, self-checking, resumable** process:

> analyze the request → break it into parts → break parts into doable, checkable
> bits (nested ≤ 3 levels) → each bit carries direction + candidate research areas
> → re-check the whole checklist → run in logical order → update a living doc as it
> goes → spawn sub-agents for independent branches when it helps.

This is the structured, upfront version of the `gapSteps()` refinement loop that
already exists: **the tree gives breadth, the gap-loop closes depth per leaf.**

## Non-goals / guardrails

- **Not always-on.** 3-level decomposition on "is X true?" invents fake structure
  and burns tokens/latency. Depth must be *earned* (see Tiering).
- **Bounded.** Hard caps on depth (≤3), node count, and a token/time budget so a
  run can't sprawl. X-mention replies still need to post in a reasonable window.
- **"testable" reframed.** Research leaves aren't unit-testable; each leaf instead
  carries an explicit **success criterion** (what evidence resolves it). That is
  what makes a bit "doable and checkable."

## Runtime reality: what a "sub-agent" is here

This runs inside the Hunter node daemon and calls the LLM via `reason()`
(`runner/lib/compose.js`, Claude backend) — **not** the Claude Code Agent tool.
A "sub-agent" is therefore one of:
- **(default) in-process branch worker** — a recursive `researchNode()` on a
  sub-question, run with a small concurrency cap (`Promise` fan-out). Simple, no
  IPC.
- **subprocess worker** — spawn `node deep_research.js --node <file>` (mirrors how
  `telegram_bot.js` spawns `deep_research.js`). Only for genuinely large/isolated
  branches; more overhead.

Start with in-process workers; add subprocess isolation only if a branch is heavy.

## The tree / living doc

Persisted to `state/research_jobs/<job_id>.json`, updated after every node so the
run is observable and resumable (mirrors the `publish_report` pattern).

```jsonc
{
  "job_id": "…", "question": "…", "tier": "deep",
  "budget": { "max_depth": 3, "max_nodes": 24, "max_tokens": 120000, "spent": 0 },
  "status": "planning|reviewing|running|done",
  "root": {
    "id": "1",
    "title": "Current pump.fun meta",
    "question": "What is the current meta on pump.fun trenches?",
    "direction": "Establish live trending set, then explain the dominant narrative",
    "research_areas": ["live trending tokens", "why-driver", "risk"],
    "tools_hint": ["trending", "search", "rugcheck"],
    "success_criterion": "Name the dominant meta + the driver, with sourced data",
    "depends_on": [],
    "status": "pending|running|answered|unresolvable",
    "findings": [], "answer": null,
    "children": [ /* ≤ 3 levels deep, same shape */ ]
  }
}
```

## Flow

1. **classify(question)** → `trivial | standard | deep`. One cheap `reason()` call.
   - `trivial`/`standard` → keep the **current** flat `plan → execute → gapSteps →
     synthesize` path (fast tier — unchanged).
   - `deep` (multi-part asks, "do a deep research", broad "state of X") → tree path.
2. **decompose(question)** → build the tree. Each node gets question, direction,
   research_areas, tools_hint, success_criterion, depends_on. Enforce depth/node
   caps. Leaves = "one focused tool sequence answers this."
3. **reviewPlan(tree)** → the *second check*: one `reason()` pass over the whole
   checklist for (a) gaps/missing angles, (b) overlap/redundancy, (c) leaves no
   tool can resolve (mark `unresolvable` up front), (d) dependency sanity. Revise
   once. **Highest ROI step.**
4. **executeTree(tree)** → topological order over `depends_on`; independent
   branches fan out (concurrency cap, e.g. 3). Each leaf:
   `execute(tools_hint steps) → adaptiveFetch → gapSteps closure → node.answer`.
   Write the doc after each node.
5. **synthesize(tree)** → report is assembled from the resolved tree (structure is
   already there → richer, better-organized report + a real "what's genuinely
   unresolvable" section). Feeds the existing `findingsToBlocks` / `publishReport`.

## Integration points (existing code, reused)

- `TOOLS`, `execute()`, `adaptiveFetch()`, `gapSteps()` → reused per leaf as-is.
- `plan()`/`deepResearch()` flat path → becomes the `trivial|standard` tier.
- `synthesize()` → gains a tree-aware variant.
- `findingsToBlocks()` + `runner/publish_report.js` → unchanged; consume the tree.
- New: `state/research_jobs/` dir, `classify()`, `decompose()`, `reviewPlan()`,
  `executeTree()`, `researchNode()`.

## Build order (incremental)

1. **Tree core (sequential):** classify + decompose + reviewPlan + living doc +
   sequential executeTree + tree-aware synthesize. Keep flat path for fast tier.
   *(Biggest quality jump; self-contained.)*
2. **Parallel branches / sub-agent workers** with a concurrency cap.
3. **`x.com/search` sentiment tool** — closes the one gap that stays open now
   (live trader sentiment), reusing the HelmStack browser.

## Open design questions (for review)

1. **Tiering trigger** — auto-classify, or explicit (e.g. Telegram `/dr` = deep,
   X-mention = standard unless the mention says "deep research")?
2. **Budget defaults** — max_nodes / token ceiling per tier? Reply latency target
   for the X path?
3. **Sub-agent default** — in-process only for v1, or subprocess isolation too?
4. **Doc format** — JSON only, or also render a live Markdown checklist (nice for
   the report + human-watchable)?
