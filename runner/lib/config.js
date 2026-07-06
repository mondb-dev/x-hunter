'use strict';

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const RUNNER_DIR = path.join(PROJECT_ROOT, 'runner');

// Env override for a numeric setting; falls back when unset/non-numeric (accepts 0).
const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : dflt;
};

module.exports = {
  // ── Timing ────────────────────────────────────────────────────────────────
  BROWSE_INTERVAL: 1800,       // 30 minutes in seconds
  TWEET_EVERY: 6,              // tweet on cycles 6, 12, 18, ... (every 2 hours)
  QUOTE_OFFSET: 3,             // quote-tweet on cycles 3, 9, 15, ... (midpoint)
  CURIOSITY_EVERY: 12,         // refresh curiosity directive every ~4h

  // ── Hours (UTC) ───────────────────────────────────────────────────────────
  // Env-overridable (TWEET_START/TWEET_END). Set 0/24 in .env to disable the
  // silent-hours posting window entirely (post around the clock).
  TWEET_START: envInt('TWEET_START', 7),   // earliest hour to post original tweets
  TWEET_END:   envInt('TWEET_END', 23),    // latest hour (exclusive)

  // ── Ports ─────────────────────────────────────────────────────────────────
  GATEWAY_PORT: 18789,         // openclaw gatels Protocol port

  // ── Dates ─────────────────────────────────────────────────────────────────
  AGENT_START_DATE: '2026-02-23',

  // ── Paths ─────────────────────────────────────────────────────────────────
  PROJECT_ROOT,
  STATE_DIR,
  RUNNER_DIR,
  JOURNALS_DIR: path.join(PROJECT_ROOT, 'journals'),
  SCRAPER_DIR: path.join(PROJECT_ROOT, 'scraper'),
  STREAM_DIR: path.join(PROJECT_ROOT, 'stream'),

  // State files
  ONTOLOGY_PATH: path.join(STATE_DIR, 'ontology.json'),
  POSTS_LOG_PATH: path.join(STATE_DIR, 'posts_log.json'),
  EXTERNAL_SOURCES_PATH: path.join(STATE_DIR, 'external_sources.json'),
  PREFETCH_SOURCE_PATH: path.join(STATE_DIR, 'prefetch_source.txt'),
  BELIEF_STATE_PATH: path.join(STATE_DIR, 'belief_state.json'),
  BROWSE_NOTES_PATH: path.join(STATE_DIR, 'browse_notes.md'),
  FEED_DIGEST_PATH: path.join(STATE_DIR, 'feed_digest.txt'),
  TOPIC_SUMMARY_PATH: path.join(STATE_DIR, 'topic_summary.txt'),
  TWEET_DRAFT_PATH: path.join(STATE_DIR, 'tweet_draft.txt'),
  QUOTE_DRAFT_PATH: path.join(STATE_DIR, 'quote_draft.txt'),
  CURIOSITY_DIRECTIVE_PATH: path.join(STATE_DIR, 'curiosity_directive.txt'),
  CURIOSITY_HINT_PATH:      path.join(STATE_DIR, 'curiosity_hint.json'),
  SYNTHESIS_PROPOSALS_PATH: path.join(STATE_DIR, 'synthesis_proposals.json'),
  REFLECTION_NOTES_PATH:    path.join(STATE_DIR, 'reflection_notes.md'),
  SPRINT_CONTEXT_PATH: path.join(STATE_DIR, 'sprint_context.txt'),
  DISCOURSE_DIGEST_PATH: path.join(STATE_DIR, 'discourse_digest.txt'),
  READING_URL_PATH: path.join(STATE_DIR, 'reading_url.txt'),
  MEMORY_RECALL_PATH: path.join(STATE_DIR, 'memory_recall.txt'),
  CRITIQUE_PATH: path.join(STATE_DIR, 'critique.md'),
  COMMENT_CANDIDATES_PATH: path.join(STATE_DIR, 'comment_candidates.txt'),
  BROWSE_ARCHIVE_PATH: path.join(STATE_DIR, 'browse_archive.md'),
  ACTIVE_PLAN_PATH: path.join(STATE_DIR, 'active_plan.json'),
  LAST_DAILY_PATH: path.join(STATE_DIR, 'last_daily_at.txt'),
  HEARTBEAT_PATH: path.join(PROJECT_ROOT, 'HEARTBEAT.md'),
  INDEX_DB_PATH: path.join(STATE_DIR, 'index.db'),
  ARTICLE_META_PATH: path.join(STATE_DIR, 'article_meta.md'),

  // Runner files
  RUNNER_LOG_PATH: path.join(RUNNER_DIR, 'runner.log'),
  ORCHESTRATOR_LOG_PATH: path.join(RUNNER_DIR, 'orchestrator.log'),
  LOCKDIR: path.join(RUNNER_DIR, 'run.lock'),
  PIDFILE: path.join(RUNNER_DIR, 'run.pid'),
  PAUSE_FILE: path.join(RUNNER_DIR, 'PAUSE'),
  CLAIM_TRACKER_PATH: path.join(STATE_DIR, 'claim_tracker.json'),
  CLAIM_TRACKER_DELTA_PATH: path.join(STATE_DIR, 'claim_tracker_delta.json'),
  VERIFICATION_EXPORT_PATH: path.join(STATE_DIR, 'verification_export.json'),
  VERIFICATION_DRAFT_PATH: path.join(STATE_DIR, 'verification_draft.txt'),
  PREDICTION_DRAFT_PATH: path.join(STATE_DIR, 'prediction_draft.txt'),
  PREDICTION_LOG_PATH: path.join(STATE_DIR, 'prediction_log.jsonl'),
  PREDICTION_EXPORT_PATH: path.join(STATE_DIR, 'prediction_export.json'),
  MIND_CHANGE_STATE_PATH: path.join(STATE_DIR, 'mind_change_state.json'),

  // External logs
  GATEWAY_ERR_LOG: path.join(
    process.env.HOME || '',
    '.openclaw-x-hunter/logs/gateway.err.log'
  ),

  // ── Log rotation limits ───────────────────────────────────────────────────
  RUNNER_LOG_MAX_LINES: 5000,
  SCRAPER_LOG_MAX_LINES: 3000,
  DIGEST_MAX_LINES: 3000,
  BROWSE_ARCHIVE_MAX_LINES: 6000,
  ENGAGEMENT_SUMMARY_PATH: path.join(STATE_DIR, 'engagement_summary.json'),
  TRAJECTORY_SUMMARY_PATH: path.join(STATE_DIR, 'trajectory_summary.txt'),

  // META cycle (process improvement)
  PROCESS_PROPOSAL_PATH: path.join(STATE_DIR, 'process_proposal.json'),
  PROCESS_REFLECTION_STATE_PATH: path.join(STATE_DIR, 'process_reflection_state.json'),
  PROPOSAL_HISTORY_PATH: path.join(STATE_DIR, 'proposal_history.json'),

  // Tool dispatch (orchestrator System B)
  TOOLS_DIR:           path.join(PROJECT_ROOT, 'tools'),
  TOOL_REQUEST_PATH:   path.join(STATE_DIR, 'tool_request.json'),
  TOOL_RESULT_PATH:    path.join(STATE_DIR, 'tool_result.json'),
  TOOL_TIMEOUT_MS:     30000,
  WORKFLOW_TIMEOUT_MS: 300000,

  // Sandbox
  SANDBOXES_DIR:            path.join(PROJECT_ROOT, 'sandboxes'),
  SANDBOX_MAX_OLD_SPACE_MB: 256,
  SANDBOX_REAP_MAX_AGE_MS:  3600000,
  SANDBOX_STDIO_MAX_BYTES:  1048576,
};
