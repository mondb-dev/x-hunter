'use strict';

/**
 * cadence.js — Sebastian's self-regulated cadence engine.
 *
 * Runs after each browse cycle. Computes environmental signals
 * (signal density, belief velocity, post recency, staleness)
 * and merges with Sebastian's own directives if he wrote them.
 *
 * Sebastian controls his own rhythm: cycle pacing, post timing, browse
 * depth, and attention allocation. The orchestrator reads the output to
 * adjust cycle timing, cycle type, and browse depth for the next cycle.
 *
 * Guardrails:
 *   - cycle_interval_sec: clamped to [900, 3600]
 *   - next_cycle_type: only "BROWSE", "TWEET", "QUOTE", or null
 *   - max 3 consecutive type overrides before forced reset
 *   - history capped at 24 entries
 */

const fs = require('fs');
const path = require('path');
const config = require('./lib/config');

const CADENCE_PATH = path.join(config.STATE_DIR, 'cadence.json');

// ── Defaults & guardrails ───────────────────────────────────────────────────

const DEFAULTS = {
  cycle_interval_sec: 1800,
  next_cycle_type: null,
  browse_depth: 'normal',
  post_eagerness: 'normal',
  curiosity_intensity: 'normal',
};

const MIN_INTERVAL = 900;     // 15 minutes
const MAX_INTERVAL = 3600;    // 60 minutes
const MAX_CONSECUTIVE_OVERRIDES = 3;
const HISTORY_CAP = 24;

const VALID_CYCLE_TYPES = ['BROWSE', 'TWEET', 'QUOTE', null];
const VALID_DEPTH = ['shallow', 'normal', 'deep'];
const VALID_EAGERNESS = ['suppress', 'normal', 'eager'];
const VALID_INTENSITY = ['low', 'normal', 'high'];
const VALID_DENSITY = ['high', 'medium', 'low'];

// ── Read helpers ────────────────────────────────────────────────────────────

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

function loadCadence() {
  const m = readJson(CADENCE_PATH);
  if (!m) return createFresh();
  return m;
}

function createFresh() {
  return {
    version: 1,
    last_assessed: null,
    assessment: {
      signal_density: 'medium',
      belief_velocity: 'medium',
      post_pressure: 'low',
      staleness: 'low',
      focus_note: '',
    },
    directives: { ...DEFAULTS },
    consecutive_overrides: 0,
    history: [],
  };
}

// ── Signal computation ──────────────────────────────────────────────────────

/**
 * Compute signal density from feed_digest.txt.
 * Counts TRENDING clusters and <- novel singletons in the last digest.
 */
function computeSignalDensity() {
  try {
    const digest = fs.readFileSync(config.FEED_DIGEST_PATH, 'utf-8');
    const trendingCount = (digest.match(/TRENDING/gi) || []).length;
    const novelCount = (digest.match(/<- novel/gi) || []).length;
    const total = trendingCount + novelCount;
    if (total >= 8) return 'high';
    if (total >= 3) return 'medium';
    return 'low';
  } catch { return 'medium'; }
}

/**
 * Compute belief velocity — how many evidence entries were added in the last 2 hours.
 */
function computeBeliefVelocity() {
  try {
    const ont = readJson(config.ONTOLOGY_PATH);
    if (!ont || !ont.axes) return 'medium';
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    let recentEvidence = 0;
    for (const axis of ont.axes) {
      for (const ev of (axis.evidence_log || [])) {
        if (ev.timestamp && new Date(ev.timestamp).getTime() > twoHoursAgo) {
          recentEvidence++;
        }
      }
    }
    if (recentEvidence >= 15) return 'high';
    if (recentEvidence >= 5) return 'medium';
    return 'low';
  } catch { return 'medium'; }
}

/**
 * Compute post pressure — how long since the last post.
 * If it's been 4+ hours and there's material, pressure is high.
 */
function computePostPressure() {
  try {
    const log = readJson(config.POSTS_LOG_PATH);
    if (!log || !log.posts || log.posts.length === 0) return 'high';
    const last = log.posts[log.posts.length - 1];
    const sinceLast = Date.now() - new Date(last.posted_at).getTime();
    const hours = sinceLast / (3600 * 1000);
    if (hours >= 6) return 'high';
    if (hours >= 3) return 'medium';
    return 'low';
  } catch { return 'medium'; }
}

/**
 * Compute staleness — are browse_notes repeating the same themes?
 * Simple heuristic: if browse_notes is very short, nothing new is landing.
 */
function computeStaleness() {
  try {
    const notes = fs.readFileSync(config.BROWSE_NOTES_PATH, 'utf-8');
    const lines = notes.trim().split('\n').length;
    if (lines <= 3) return 'high';
    if (lines <= 15) return 'medium';
    return 'low';
  } catch { return 'medium'; }
}

// ── Main assessment ─────────────────────────────────────────────────────────

/**
 * Run cadence assessment.
 *
 * 1. Compute environmental signals.
 * 2. Read Sebastian's agent-written directives (if any) from cadence.json.
 * 3. Merge: agent directives take priority, but guardrails are enforced.
 * 4. Write updated cadence.json.
 */
function assess() {
  const meta = loadCadence();
  const now = new Date().toISOString();

  // ── Compute environmental assessment ────────────────────────────────────
  const computed = {
    signal_density: computeSignalDensity(),
    belief_velocity: computeBeliefVelocity(),
    post_pressure: computePostPressure(),
    staleness: computeStaleness(),
  };

  // ── Read agent-written directives (agent may have updated the file) ─────
  // The agent writes to cadence.json directly during browse cycles.
  // We preserve the agent's directives and focus_note if present.
  const agentDirectives = meta.directives || {};
  const agentAssessment = meta.assessment || {};

  // ── Merge assessment (computed signals + agent's focus_note) ─────────────
  const assessment = {
    signal_density: computed.signal_density,
    belief_velocity: computed.belief_velocity,
    post_pressure: computed.post_pressure,
    staleness: computed.staleness,
    focus_note: agentAssessment.focus_note || '',
  };

  // ── Merge directives (agent overrides + guardrails) ─────────────────────
  const directives = { ...DEFAULTS };

  // Interval: agent can set, but clamped
  if (agentDirectives.cycle_interval_sec != null) {
    directives.cycle_interval_sec = Math.max(
      MIN_INTERVAL,
      Math.min(MAX_INTERVAL, agentDirectives.cycle_interval_sec)
    );
  } else {
    // Auto-compute from signals
    directives.cycle_interval_sec = autoInterval(computed);
  }

  // Next cycle type: agent can override, but limited consecutive overrides
  if (agentDirectives.next_cycle_type &&
      VALID_CYCLE_TYPES.includes(agentDirectives.next_cycle_type)) {
    if (meta.consecutive_overrides < MAX_CONSECUTIVE_OVERRIDES) {
      directives.next_cycle_type = agentDirectives.next_cycle_type;
    } else {
      // Forced reset — too many consecutive overrides
      directives.next_cycle_type = null;
      console.log('[cadence] override limit reached — resetting to default pattern');
    }
  }

  // Browse depth
  if (agentDirectives.browse_depth && VALID_DEPTH.includes(agentDirectives.browse_depth)) {
    directives.browse_depth = agentDirectives.browse_depth;
  }

  // Post eagerness — agent can request eager/normal but NOT suppress.
  // Suppress kills journal production; only manual intervention should set it.
  if (agentDirectives.post_eagerness && VALID_EAGERNESS.includes(agentDirectives.post_eagerness)) {
    if (agentDirectives.post_eagerness === "suppress") {
      console.log("[cadence] BLOCKED: agent requested post_eagerness=suppress — ignoring (use manual override)");
    } else {
      directives.post_eagerness = agentDirectives.post_eagerness;
    }
  }





  // Curiosity intensity
  if (agentDirectives.curiosity_intensity && VALID_INTENSITY.includes(agentDirectives.curiosity_intensity)) {
    directives.curiosity_intensity = agentDirectives.curiosity_intensity;
  }

  // ── Track consecutive overrides ───────────────────────────────────────────
  const consecutiveOverrides = directives.next_cycle_type
    ? (meta.consecutive_overrides || 0) + 1
    : 0;

  // ── Build history entry ───────────────────────────────────────────────────
  const historyEntry = {
    ts: now,
    assessment: { ...assessment },
    directives: { ...directives },
  };

  const history = [...(meta.history || []), historyEntry].slice(-HISTORY_CAP);

  // ── Write ─────────────────────────────────────────────────────────────────
  const output = {
    version: 1,
    last_assessed: now,
    assessment,
    directives,
    consecutive_overrides: consecutiveOverrides,
    history,
  };

  fs.writeFileSync(CADENCE_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`[cadence] assessed: density=${assessment.signal_density} velocity=${assessment.belief_velocity} pressure=${assessment.post_pressure} staleness=${assessment.staleness}`);
  console.log(`[cadence] directives: interval=${directives.cycle_interval_sec}s type=${directives.next_cycle_type || 'auto'} depth=${directives.browse_depth} eagerness=${directives.post_eagerness}`);

  return output;
}

// ── Auto-interval computation ───────────────────────────────────────────────

/**
 * Suggest a cycle interval based on environmental signals.
 * High signal density + high velocity → shorter cycles (faster absorption).
 * Low density + high staleness → longer cycles (save resources).
 */
function autoInterval(signals) {
  let score = 0;

  // Signal density
  if (signals.signal_density === 'high') score += 2;
  else if (signals.signal_density === 'medium') score += 1;

  // Belief velocity
  if (signals.belief_velocity === 'high') score += 2;
  else if (signals.belief_velocity === 'medium') score += 1;

  // Post pressure (high pressure = should shift to posting, not browse faster)
  if (signals.post_pressure === 'high') score += 1;

  // Staleness (high staleness = slow down)
  if (signals.staleness === 'high') score -= 2;
  else if (signals.staleness === 'medium') score -= 1;

  // Map score to interval
  // score range: -2 to +5
  if (score >= 4) return 1200;    // 20 min — fast absorption mode
  if (score >= 2) return 1500;    // 25 min — active
  if (score >= 0) return 1800;    // 30 min — default
  if (score >= -1) return 2400;   // 40 min — slow
  return 3000;                     // 50 min — very quiet
}

// ── Read directives (for orchestrator consumption) ──────────────────────────

/**
 * Read the current cadence directives.
 * Returns defaults if file is missing or corrupt.
 */
function readDirectives() {
  try {
    const m = readJson(CADENCE_PATH);
    if (!m || !m.directives) return { ...DEFAULTS, consecutive_overrides: 0 };
    return {
      ...DEFAULTS,
      ...m.directives,
      consecutive_overrides: m.consecutive_overrides || 0,
    };
  } catch {
    return { ...DEFAULTS, consecutive_overrides: 0 };
  }
}

/**
 * Clear the next_cycle_type override after it's been consumed.
 * Called by the orchestrator after applying the override.
 */
function consumeOverride() {
  try {
    const m = readJson(CADENCE_PATH);
    if (!m) return;
    if (m.directives) {
      m.directives.next_cycle_type = null;
    }
    fs.writeFileSync(CADENCE_PATH, JSON.stringify(m, null, 2) + '\n');
  } catch {}
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = { assess, readDirectives, consumeOverride };

// CLI mode
if (require.main === module) {
  const result = assess();
  console.log(JSON.stringify(result, null, 2));
}
