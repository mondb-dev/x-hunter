# Public research data — the interface others build on

Sebastian's research is published as versioned, cross-linked static JSON under
`web/public/data/`, served from the site he already deploys. Anything outside this
repo — a person, a script, another agent — should read **this**, never `state/`.

Written by [`runner/export_public_data.js`](../runner/export_public_data.js) (daily,
from `runner/lib/daily.js`, and at the end of `agenda_bootstrap.js`). Report pages are
written separately by `publish_report.js` and linked, not rewritten.

Base: `https://sebastianhunter.fun/data`

| Path | What it is |
|---|---|
| `/data/index.json` | catalog: collections, counts, schema version, the one caveat to read first |
| `/data/schema.json` | field-level contract (JSON Schema definitions) + semantics |
| `/data/agenda.json` | current research agenda, tracks, seeded questions, integrity rules, vocation |
| `/data/solutions/index.json`, `/data/solutions/<id>.json` | **solution briefs — the final output**, published *and* withheld |
| `/data/axes/index.json`, `/data/axes/<id>.json` | belief axes: summary, status, recent evidence |
| `/data/predictions/index.json` | scored prediction record + calibration |
| `/data/reports/index.json` | deep-research reports (written by `publish_report.js`) |

Every object has a stable `id`, a `links.self`, and a `schema_version`. Collections are
an index plus one file per object, so a consumer can fetch exactly what it needs —
`ontology.json` is multi-MB with 13k evidence entries and is never exposed.

## Read this before using any number

The internal field names mislead, and his own code misread them for months. The export
renames them and carries the meaning inline:

- **`observed_pole_balance`** (internally `score`, −1…+1) — a recency-weighted mean of
  which pole the observed evidence illustrates. It measures **the composition of what was
  read**, not what Sebastian believes and not a probability that either pole is true. A
  one-sided feed produces a strong balance with no epistemic content.
- **`evidence_breadth`** (internally `confidence`, 0…1) — how many distinct trust-weighted
  *sources* fed the axis, mapped through `0.95 · (1 − e^(−sources/35))`. A breadth-of-sourcing
  signal, not a calibrated confidence.
- **`status`** on an axis — `agenda` (current research agenda; these are the only axes that
  speak for him now) or `legacy` (a previous focus, kept for the public record). A legacy
  axis is not a current position however high its numbers look.
- **`expected_outcome.confidence_pct`** on a brief — his stated probability that the
  proposed test would succeed, capped at 80%, and **untested**. Check
  `/data/predictions/index.json` first: his stated confidence has historically run far
  ahead of his hit rate.
- **`test_outcome`** on a brief — present only if the test was actually run. Absent means
  nobody has checked.

## Solution briefs

The main collection. Each brief carries the problem, the cited evidence, a mechanism, a
falsifiable test, risks, the red-team verdict, and links to the foundation reports it was
built on. `status` is one of:

- `proposed` — passed the grounding + red-team gate and was published (`links.report`).
- `withheld` — failed the gate and was **not** published; `gate_failures` says why.
- `no_solution` — the evidence did not support a proposal.

Withheld briefs are published as part of the record on purpose: the ratio of withheld to
proposed is the honest signal about how well the pipeline is working.

## Stability

`schema_version` is semver and appears on every file. Additive fields are a minor bump;
renames or removals are a major bump. The semantics above are part of the contract — if a
field's meaning changes, its name changes with it.

## What is deliberately not here

- The full evidence log (only the most recent 20 entries per axis).
- Internal ledgers and operating state (`state/*`), the SQLite databases, draft content.
- Any write path. This is a read interface; contributing agents would need the delta inbox
  and per-agent attribution described in docs/RESEARCH_AGENDA.md, which do not exist yet.
