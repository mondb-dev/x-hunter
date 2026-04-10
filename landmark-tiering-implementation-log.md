# Landmark Tiering Implementation Log

Date: 2026-04-03

## Summary

The landmark pipeline now uses gate-derived tiers instead of raw signal-count rarity.

New edition model:

- `candidate`: internal only, no article, no NFT
- `tier_2`: article signal, 30 editions
- `tier_1`: NFT signal, 15 editions
- `special_vocation`: vocation-change landmark, 3 editions
- `special_prediction`: retroactively validated structural-signal landmark, 1 edition

## Important changes

### 1. Added a shared gate/tier resolver

File:

- `runner/landmark/tiering.js`

What it does:

- Computes evidence density from the sampled posts
- Computes a heuristic `coherenceScore`
- Evaluates stage gates:
  - candidate
  - article
  - mint
  - special vocation
  - special prediction
- Validates editorial output for Tier 1 eligibility

Important gate logic:

- Article gate requires:
  - `signalCount >= 4`
  - `crossCluster = true`
  - evidence density pass
  - `coherenceScore >= 0.55`
- Mint gate requires:
  - `signalCount >= 5`
  - `crossCluster = true`
  - `multiAxis = true`
  - evidence density pass
  - `coherenceScore >= 0.72`
  - editorial validation pass
  - canonical landmark artifact exists
- `special_prediction` only resolves if prediction validation is explicitly true

### 2. Replaced legacy signal-count rarity with explicit tier definitions

File:

- `runner/landmark/config.js`

What changed:

- Removed the old `3/4/5-6 signals -> Bronze/Silver/Gold` edition model
- Added `LANDMARK_TIERS` as the new source of truth
- Set supplies to:
  - Tier 2: 30
  - Tier 1: 15
  - Special vocation: 3
  - Special prediction: 1

### 3. Landmark publication now respects the gate result

File:

- `runner/landmark/index.js`

What changed:

- The pipeline now evaluates the strongest event before publication
- Candidate-only events are skipped instead of being auto-published as articles
- Editorial validation is run after generation
- Final tier/stage metadata is attached to the event and written into the manifest

Important note:

- This is the main behavioral shift. The pipeline no longer treats every detected event as article-worthy.

### 4. NFT metadata and card rendering now use gate tiers

Files:

- `runner/landmark/mint.js`
- `runner/landmark/card.js`
- `runner/landmark/render.js`
- `runner/landmark/art.js`

What changed:

- Mint metadata now records both `Tier` and `Tier ID`
- Card visuals now derive from:
  - Tier 2
  - Tier 1
  - Special vocation
  - Special prediction
- Hero-art prompt mood now keys off the new tier names
- Render and mint paths now use `event.date` / `event.windowTs` instead of the broken `event.windowStart`

### 5. Landmark state/logging now records stage and tier

File:

- `runner/landmark/state.js`

What changed:

- Added counters:
  - `total_candidates`
  - `total_published`
  - `total_minted`
- Landmark log entries now store:
  - `stage`
  - `tier`
  - `edition_supply`
  - `article_url`

### 6. Fixed the landmark number bug in archived editorial HTML

File:

- `runner/landmark/editorial.js`

What changed:

- `buildArweaveHtml()` now accepts `landmarkNumber` explicitly
- This removes the old reliance on missing event state when writing editorial artifacts

## Verification run

Syntax checks passed:

- `node --check runner/landmark/config.js`
- `node --check runner/landmark/tiering.js`
- `node --check runner/landmark/index.js`
- `node --check runner/landmark/mint.js`
- `node --check runner/landmark/card.js`
- `node --check runner/landmark/render.js`
- `node --check runner/landmark/editorial.js`
- `node --check runner/landmark/art.js`
- `node --check runner/landmark/state.js`

Lightweight runtime checks passed:

- Gate evaluation resolves a strong example event to `mint -> tier_1`
- Editorial validation accepts a grounded sample editorial
- Card rendering resolves `special_prediction` badge text correctly

## Known limitations

- The NFT mint pipeline is still disabled at the top-level orchestrator path
- `special_vocation` and `special_prediction` support is now implemented in the tier resolver, but automatic trigger creation for those events is not yet wired end-to-end
- `special_prediction` assumes explicit retroactive validation input rather than inferring it automatically from `retroactive_events.json`
- Coherence and editorial validation are heuristic, not the full structured JSON validation flow proposed in `context-bridge.md`

## Files changed

- `runner/landmark/config.js`
- `runner/landmark/tiering.js`
- `runner/landmark/index.js`
- `runner/landmark/mint.js`
- `runner/landmark/card.js`
- `runner/landmark/render.js`
- `runner/landmark/art.js`
- `runner/landmark/editorial.js`
- `runner/landmark/state.js`
- `landmark-tiering-implementation-log.md`
