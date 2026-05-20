# Research Capability Improvements

Audit date: 2026-05-20  
Based on: code review of `browse.js`, `context.js`, `apply_ontology_delta.js`, `gemini_agent.js`, `curiosity.js`

All claims were verified against actual source code before being included here.

---

## Verified weaknesses

| # | Weakness | Code location |
|---|----------|---------------|
| 1 | Confidence formula ignores source quality — purely `uniqueSources × 0.025` | `apply_ontology_delta.js:579` |
| 2 | Agent cannot redirect its own investigation mid-cycle | `browse.js:40-41`; `curiosity.js` is orchestrator-only |
| 3 | Cross-axis contradiction detection exists but never produces belief synthesis | `curiosity.js:378-429` |
| 4 | Journal section 2 is an unconditional dump of all `browse_notes.md` entries | `context.js:196-206` |
| 5 | `browse_notes.md` grows unbounded; agent sees only last 80 lines but file is never pruned | `browse.js:120`; `context.js:328` |
| 6 | Tool results appear in the *next* cycle's context (1-cycle async lag) | `browse.js:178-189` |
| 7 | Reflection (journal synthesis) happens in the same cycle as browsing — zero temporal distance | `context.js` journal task |
| 8 | `ontology_merge_proposals.txt` has no processor — proposals sit unread | no consumer found in codebase |

---

## Improvements

### Priority 1 — Implemented 2026-05-20

---

#### 1.1 Agent-proposable curiosity hints ✓

**Gap:** When the agent finds something genuinely surprising mid-cycle, it cannot redirect its own investigation. The curiosity directive is recomputed by the orchestrator every 12 cycles — whatever the agent notices is lost until then.

**Implemented:**

- `runner/lib/prompts/browse.js` — task 4b: agent writes `state/curiosity_hint.json` when warranted (not routinely)
- `runner/curiosity.js` — priority path #2 (after discourse, before sprint): reads hint, builds directive, deletes hint (one-shot consumption)
- `runner/lib/config.js` — `CURIOSITY_HINT_PATH` added

Hint schema written by agent:
```json
{
  "suggested_query": "search terms for next directive cycle",
  "suggested_url": "(optional) specific URL",
  "axis_id": "(optional) axis this relates to",
  "reason": "1-2 sentences: what you found and why it needs follow-up",
  "urgency": "low | medium | high",
  "written_at_cycle": 42
}
```

Curiosity driver priority is now: `discourse → agent_hint → sprint_research → contradiction → uncertainty_axis → trending`

---

#### 1.2 Cross-axis synthesis pass ✓

**Gap:** `curiosity.js` already identifies tension pairs (opposing axes with overlapping topics). It uses this only to generate curiosity directives. When both sides accumulate evidence, nothing synthesises them.

**Implemented:**

- `runner/synthesize_axes.js` — new file, runs daily. Finds tension pairs (`confidence ≥ 0.60`, `evidence_log ≥ 8`, `|score| > 0.15`, `overlap ≥ 2 tokens`). Writes up to 5 new proposals per run to `state/synthesis_proposals.json`. Deduplicates across runs.
- `runner/lib/prompts/context.js` — `loadSynthesisProposals()` injects top 3 pending proposals (by tension score) as `ctx.synthesisPending`
- `runner/lib/prompts/browse.js` — SYNTHESIS PENDING data section (conditional) + task 4c: agent drafts synthesis axis into `ontology_delta.json` with `synthesis_of: [axis_a_id, axis_b_id]` field
- `runner/lib/config.js` — `SYNTHESIS_PROPOSALS_PATH` added
- `runner/run.sh` — `synthesize_axes.js` scheduled in daily maintenance block

Synthesis proposal schema (`state/synthesis_proposals.json`):
```json
{
  "proposals": [
    {
      "id": "synth_<axis_a_id>_<axis_b_id>",
      "axis_a_id": "...", "axis_a_label": "...", "axis_a_score": 0,
      "axis_b_id": "...", "axis_b_label": "...", "axis_b_score": 0,
      "tension": 0, "score": 0,
      "created_at": "ISO",
      "status": "pending"
    }
  ]
}
```

Agent marks acceptance in `browse_notes.md` with `[SYNTHESIS] <proposal_id> — drafted as <new_axis_id>`.

---

### Priority 2 — Implemented 2026-05-20

---

#### 2.1 Source quality weighting in confidence ✓

**Gap:** Trust scores (T=0-10) are computed for every feed entry and affect axis *score*, but confidence is purely `uniqueSources × 0.025`. A T=9 Reuters source and a T=2 anonymous blog both contribute identically to confidence.

**Implemented:** `runner/apply_ontology_delta.js` confidence formula updated. Per unique source URL, takes the max `trust_weight` across its entries (range [0.5–2.0]; default 1.0 for unknown sources). Sums weights across sources; keeps 0.025 scalar so neutral sources behave identically to before.

```javascript
// before
const uniqueSources = new Set(log.filter(e => e && e.source).map(e => e.source)).size;
axis.confidence = parseFloat(Math.min(0.98, uniqueSources * 0.025).toFixed(4));

// after
const sourceWeights = new Map();
for (const e of log) {
  if (!e || !e.source) continue;
  const w = e.trust_weight ?? 1.0;
  if (!sourceWeights.has(e.source) || sourceWeights.get(e.source) < w)
    sourceWeights.set(e.source, w);
}
const weightedSources = [...sourceWeights.values()].reduce((s, w) => s + w, 0);
axis.confidence = parseFloat(Math.min(0.98, weightedSources * 0.025).toFixed(4));
```

`trust_weight` was already stored in every evidence entry — no agent prompt changes needed. On live ontology: 12/37 axes shifted by ±0.02–0.06, all in the correct direction (low-trust source clusters decrease confidence, high-trust increase it).

---

#### 2.2 Reflection cycle (separate from browse)

**Gap:** The journal synthesis narrative is written by the same model in the same cycle as browsing. There is zero temporal distance between observation and reflection. The agent is simultaneously navigating, noting, and synthesising — these compete for attention.

**Fix:** Add a `REFLECT` cycle type to `run.sh`, scheduled daily (e.g., 06:00). No browser tools. Input: last 7 days of journal section 1 narratives + current `ontology.json`. Task: identify cross-cycle patterns, what shifted, what is unresolved, what the agent got wrong. Output: `state/reflection_notes.md` (appended), injected into the next browse cycle's context as `ctx.lastReflection`.

**Files to change:** `run.sh` (add REFLECT block), `runner/lib/prompts/context.js` (inject `lastReflection`), new prompt file `runner/lib/prompts/reflect.js`.

---

### Priority 3 — Noise reduction

---

#### 3.1 browse_notes.md rotation

`browse_notes.md` grows without bound. The agent sees only the last 80 lines regardless. Everything older than 80 lines is invisible to the agent but still written into every journal.

Fix: weekly rotation into `state/browse_notes_archive/YYYY-WNN.md`. Add to `run.sh` Monday 00:00 block.

---

#### 3.2 Journal section 2 cleanup

The mandatory full-copy of `browse_notes.md` in every journal adds no analytical value beyond what section 1 already synthesises. `[NOTED]` entries in particular ("saw it, didn't examine") are low-signal noise in the permanent record.

Options (pick one):
- **Minimal:** exclude `[NOTED]` entries from section 2
- **Better:** section 2 includes only entries that generated an `ontology_delta.json` entry that cycle, plus entries tagged `[CURIOSITY]` or `[SPRINT]`
- **Clean:** remove section 2 entirely; raw observations already exist in `browse_notes.md` which is Arweave-archived separately

The prompt change is in `context.js:196-206`.

---

## Status

| Item | Status | Date |
|------|--------|------|
| 1.1 Agent curiosity hints | **Done** | 2026-05-20 |
| 1.2 Cross-axis synthesis pass | **Done** | 2026-05-20 |
| 2.1 Trust-weighted confidence | **Done** | 2026-05-20 |
| 2.2 Reflection cycle | Pending | — |
| 3.1 browse_notes rotation | Pending | — |
| 3.2 Journal section 2 cleanup | Pending | — |
